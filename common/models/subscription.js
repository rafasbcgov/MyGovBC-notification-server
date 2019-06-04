const path = require('path')
var rsaPath = path.resolve(__dirname, '../../server/boot/rsa.js')
var rsa = require(rsaPath)
var RandExp = require('randexp')
var disableAllMethods = require('../helpers.js').disableAllMethods
var _ = require('lodash')
var jmespath = require('jmespath')

module.exports = function(Subscription) {
  disableAllMethods(Subscription, [
    'find',
    'create',
    'patchAttributes',
    'replaceById',
    'deleteItemById',
    'verify',
    'count',
    'getSubscribedServiceNames'
  ])

  function accessCheckForGetRequest() {
    var ctx = arguments[0]
    var next = arguments[arguments.length - 1]
    var userId = Subscription.getCurrentUser(ctx)
    if (userId || Subscription.isAdminReq(ctx)) {
      return next()
    }
    var error = new Error('Forbidden')
    error.status = 403
    return next(error)
  }

  Subscription.beforeRemote('find', accessCheckForGetRequest)
  Subscription.beforeRemote('count', accessCheckForGetRequest)

  Subscription.observe(
    'before save',
    function parseBroadcastPushNotificationFilter(ctx, next) {
      let data = ctx.instance || ctx.data
      if (!data) {
        return next()
      }
      let filter = data.broadcastPushNotificationFilter
      if (!filter) {
        return next()
      }
      if (typeof filter !== 'string') {
        let error = new Error('invalid broadcastPushNotificationFilter')
        error.status = 400
        return next(error)
      }
      filter = '[?' + filter + ']'
      try {
        jmespath.compile(filter)
      } catch (ex) {
        let error = new Error('invalid broadcastPushNotificationFilter')
        error.status = 400
        return next(error)
      }
      return next()
    }
  )

  Subscription.observe('access', function(ctx, next) {
    var u = Subscription.getCurrentUser(ctx.options.httpContext)
    if (u) {
      ctx.query.where = ctx.query.where || {}
      ctx.query.where.userId = u
      ctx.query.where.state = {
        neq: 'deleted'
      }
    }
    next()
  })

  /**
   * hide confirmation request field, especially confirmation code
   */
  Subscription.afterRemote('**', function() {
    var ctx = arguments[0]
    var next = arguments[arguments.length - 1]
    if (arguments.length <= 2) {
      return next()
    }
    var data = arguments[1]
    if (!data) {
      return next()
    }
    if (!Subscription.isAdminReq(ctx)) {
      if (data instanceof Array) {
        data.forEach(function(e) {
          e.confirmationRequest = undefined
          e.unsetAttribute('updatedBy')
          e.unsetAttribute('createdBy')
          e.unsetAttribute('unsubscriptionCode')
        })
      } else if (data instanceof Object) {
        data.confirmationRequest = undefined
        data.unsetAttribute('updatedBy')
        data.unsetAttribute('createdBy')
        data.unsetAttribute('unsubscriptionCode')
      }
    }
    return next()
  })

  async function handleConfirmationRequest(ctx, data, cb) {
    if (data.state !== 'unconfirmed' || !data.confirmationRequest.sendRequest) {
      return cb(null, null)
    }
    let textBody =
      data.confirmationRequest.textBody &&
      Subscription.mailMerge(data.confirmationRequest.textBody, data, ctx)
    let mailSubject =
      data.confirmationRequest.subject &&
      Subscription.mailMerge(data.confirmationRequest.subject, data, ctx)
    let mailHtmlBody =
      data.confirmationRequest.htmlBody &&
      Subscription.mailMerge(data.confirmationRequest.htmlBody, data, ctx)
    let mailFrom = data.confirmationRequest.from

    // handle duplicated request
    let mergedSubscriptionConfig
    try {
      mergedSubscriptionConfig = await Subscription.getMergedConfig(
        'subscription',
        data.serviceName
      )
    } catch (err) {
      if (cb) {
        return cb(err)
      } else {
        throw err
      }
    }
    if (mergedSubscriptionConfig.detectDuplicatedSubscription) {
      let whereClause = {
        serviceName: data.serviceName,
        state: 'confirmed',
        channel: data.channel
      }
      if (data.userChannelId) {
        // email address check should be case insensitive
        var escapedUserChannelId = data.userChannelId.replace(
          /[-[\]{}()*+?.,\\^$|#\s]/g,
          '\\$&'
        )
        var escapedUserChannelIdRegExp = new RegExp(escapedUserChannelId, 'i')
        whereClause.userChannelId = {
          regexp: escapedUserChannelIdRegExp
        }
      }
      let subCnt = await Subscription.count(whereClause)
      if (subCnt > 0) {
        mailFrom =
          mergedSubscriptionConfig.duplicatedSubscriptionNotification[
            data.channel
          ].from
        textBody =
          mergedSubscriptionConfig.duplicatedSubscriptionNotification[
            data.channel
          ].textBody &&
          Subscription.mailMerge(
            mergedSubscriptionConfig.duplicatedSubscriptionNotification[
              data.channel
            ].textBody,
            data,
            ctx
          )
        mailSubject =
          mergedSubscriptionConfig.duplicatedSubscriptionNotification.email
            .subject &&
          Subscription.mailMerge(
            mergedSubscriptionConfig.duplicatedSubscriptionNotification.email
              .subject,
            data,
            ctx
          )
        mailHtmlBody =
          mergedSubscriptionConfig.duplicatedSubscriptionNotification.email
            .htmlBody &&
          Subscription.mailMerge(
            mergedSubscriptionConfig.duplicatedSubscriptionNotification.email
              .htmlBody,
            data,
            ctx
          )
      }
    }
    switch (data.channel) {
      case 'sms':
        Subscription.sendSMS(data.userChannelId, textBody, cb)
        break
      default: {
        let mailOptions = {
          from: mailFrom,
          to: data.userChannelId,
          subject: mailSubject,
          text: textBody,
          html: mailHtmlBody
        }
        Subscription.sendEmail(mailOptions, cb)
      }
    }
  }

  function beforeUpsert(ctx, unused, next) {
    var data = ctx.args.data
    Subscription.getMergedConfig(
      'subscription',
      data.serviceName,
      (err, mergedSubscriptionConfig) => {
        if (err) {
          return next(err)
        }
        var userId = Subscription.getCurrentUser(ctx)
        if (userId) {
          data.userId = userId
        } else if (!Subscription.isAdminReq(ctx) || !data.unsubscriptionCode) {
          // generate unsubscription code
          var anonymousUnsubscription =
            mergedSubscriptionConfig.anonymousUnsubscription
          if (
            anonymousUnsubscription.code &&
            anonymousUnsubscription.code.required
          ) {
            var unsubscriptionCodeRegex = new RegExp(
              anonymousUnsubscription.code.regex
            )
            data.unsubscriptionCode = new RandExp(unsubscriptionCodeRegex).gen()
          }
        }
        if (
          data.confirmationRequest &&
          data.confirmationRequest.confirmationCodeEncrypted
        ) {
          var key = rsa.key
          var decrypted
          try {
            decrypted = key.decrypt(
              data.confirmationRequest.confirmationCodeEncrypted,
              'utf8'
            )
          } catch (ex) {
            return next(ex, null)
          }
          var decryptedData = decrypted.split(' ')
          data.userChannelId = decryptedData[0]
          data.confirmationRequest.confirmationCode = decryptedData[1]
          return next()
        }
        // use request without encrypted payload
        if (!Subscription.isAdminReq(ctx) || !data.confirmationRequest) {
          try {
            data.confirmationRequest =
              mergedSubscriptionConfig.confirmationRequest[data.channel]
          } catch (ex) {}
          data.confirmationRequest.confirmationCode = undefined
        }
        if (
          !data.confirmationRequest.confirmationCode &&
          data.confirmationRequest.confirmationCodeRegex
        ) {
          var confirmationCodeRegex = new RegExp(
            data.confirmationRequest.confirmationCodeRegex
          )
          data.confirmationRequest.confirmationCode = new RandExp(
            confirmationCodeRegex
          ).gen()
        }
        return next()
      }
    )
  }

  Subscription.beforeRemote('create', function() {
    var ctx = arguments[0]
    if (!Subscription.isAdminReq(ctx)) {
      delete ctx.args.data.state
      const userId = Subscription.getCurrentUser(ctx)
      if (!userId) {
        // anonymous user is not allowed to supply data,
        // which could be used in mail merge
        delete ctx.args.data.data
      }
    }
    delete ctx.args.data.id
    beforeUpsert.apply(null, arguments)
  })
  Subscription.afterRemote('create', function(ctx, res, next) {
    if (!ctx.args.data.confirmationRequest) {
      return next()
    }
    handleConfirmationRequest(ctx, res, function(
      handleConfirmationRequestError,
      info
    ) {
      next(handleConfirmationRequestError)
    })
  })

  Subscription.beforeRemote('replaceById', function() {
    var ctx = arguments[0]
    var next = arguments[arguments.length - 1]
    if (Subscription.isAdminReq(ctx)) {
      return next()
    }
    var error = new Error('Forbidden')
    error.status = 403
    return next(error)
  })

  Subscription.beforeRemote('prototype.patchAttributes', function() {
    var ctx = arguments[0]
    var next = arguments[arguments.length - 1]
    if (Subscription.isAdminReq(ctx)) {
      return next()
    }
    var userId = Subscription.getCurrentUser(ctx)
    if (!userId) {
      var error = new Error('Forbidden')
      error.status = 403
      return next(error)
    }
    var filteredData = _.merge({}, ctx.instance)
    filteredData.userChannelId = ctx.args.data.userChannelId
    if (filteredData.userChannelId !== ctx.instance.userChannelId) {
      filteredData.state = 'unconfirmed'
    }
    ctx.args.data = filteredData
    beforeUpsert.apply(null, arguments)
  })

  Subscription.afterRemote('prototype.patchAttributes', function(
    ctx,
    instance,
    next
  ) {
    if (!ctx.args.data.confirmationRequest) {
      return next()
    }
    handleConfirmationRequest(ctx, instance, function(
      handleConfirmationRequestError,
      info
    ) {
      next(handleConfirmationRequestError)
    })
  })

  Subscription.prototype.deleteItemById = async function(
    options,
    unsubscriptionCode,
    additionalServices,
    userChannelId,
    cb
  ) {
    let forbidden = false
    let error
    if (!Subscription.isAdminReq(options.httpContext)) {
      var userId = Subscription.getCurrentUser(options.httpContext)
      if (userId) {
        if (userId !== this.userId) {
          forbidden = true
        }
      } else {
        if (
          this.unsubscriptionCode &&
          unsubscriptionCode !== this.unsubscriptionCode
        ) {
          forbidden = true
        }
        try {
          if (
            userChannelId &&
            this.userChannelId.toLowerCase() !== userChannelId.toLowerCase()
          ) {
            forbidden = true
          }
        } catch (ex) {}
      }
    }
    if (this.state !== 'confirmed') {
      forbidden = true
    }
    let mergedSubscriptionConfig
    try {
      mergedSubscriptionConfig = await Subscription.getMergedConfig(
        'subscription',
        this.serviceName
      )
    } catch (ex) {
      error = ex
    }
    if (forbidden) {
      error = new Error('Forbidden')
      error.status = 403
    }
    let anonymousUnsubscription =
      mergedSubscriptionConfig &&
      mergedSubscriptionConfig.anonymousUnsubscription
    if (error) {
      if (anonymousUnsubscription.acknowledgements.onScreen.redirectUrl) {
        var redirectUrl =
          anonymousUnsubscription.acknowledgements.onScreen.redirectUrl
        redirectUrl += '?err=' + encodeURIComponent(error)
        return await options.httpContext.res.redirect(redirectUrl)
      } else {
        options.httpContext.res.setHeader('Content-Type', 'text/plain')
        if (anonymousUnsubscription.acknowledgements.onScreen.failureMessage) {
          options.httpContext.res.status(error.status || 500)
          return await options.httpContext.res.end(
            anonymousUnsubscription.acknowledgements.onScreen.failureMessage
          )
        } else {
          return cb(error)
        }
      }
    }
    let unsubscribeItems = async (query, additionalServices) => {
      let writeErr
      try {
        await Subscription.updateAll(
          query,
          {
            state: 'deleted'
          },
          options
        )
      } catch (ex) {
        writeErr = ex
      }
      let handleUnsubscriptionResponse = async writeErr => {
        var err = writeErr
        try {
          if (!err) {
            // send acknowledgement notification
            try {
              switch (this.channel) {
                case 'email': {
                  var msg =
                    anonymousUnsubscription.acknowledgements.notification[
                      this.channel
                    ]
                  var subject = Subscription.mailMerge(
                    msg.subject,
                    this,
                    options.httpContext
                  )
                  var textBody = Subscription.mailMerge(
                    msg.textBody,
                    this,
                    options.httpContext
                  )
                  var htmlBody = Subscription.mailMerge(
                    msg.htmlBody,
                    this,
                    options.httpContext
                  )
                  let mailOptions = {
                    from: msg.from,
                    to: this.userChannelId,
                    subject: subject,
                    text: textBody,
                    html: htmlBody
                  }
                  Subscription.sendEmail(mailOptions)
                  break
                }
              }
            } catch (ex) {}
          }
          if (anonymousUnsubscription.acknowledgements.onScreen.redirectUrl) {
            var redirectUrl =
              anonymousUnsubscription.acknowledgements.onScreen.redirectUrl
            if (err) {
              redirectUrl += '?err=' + encodeURIComponent(err)
            }
            return await options.httpContext.res.redirect(redirectUrl)
          } else {
            options.httpContext.res.setHeader('Content-Type', 'text/plain')
            if (err) {
              return await options.httpContext.res.end(
                anonymousUnsubscription.acknowledgements.onScreen.failureMessage
              )
            }
            return await options.httpContext.res.end(
              anonymousUnsubscription.acknowledgements.onScreen.successMessage
            )
          }
        } catch (ex) {}
        return cb(err, 1)
      }
      if (writeErr || !additionalServices) {
        return await handleUnsubscriptionResponse(writeErr)
      }
      try {
        await this.updateAttribute(
          'unsubscribedAdditionalServices',
          additionalServices
        )
      } catch (ex) {
        writeErr = ex
      }
      await handleUnsubscriptionResponse(writeErr)
    }
    if (!additionalServices) {
      return await unsubscribeItems({
        id: this.id
      })
    }
    let getAdditionalServiceIds = async () => {
      if (additionalServices instanceof Array) {
        let res = await Subscription.find({
          fields: ['id', 'serviceName'],
          where: {
            serviceName: {
              inq: additionalServices
            },
            channel: this.channel,
            userChannelId: this.userChannelId
          }
        })
        return {
          names: res.map(e => e.serviceName),
          ids: res.map(e => e.id)
        }
      }
      if (typeof additionalServices === 'string') {
        if (additionalServices !== '_all') {
          let res = await Subscription.find({
            fields: ['id', 'serviceName'],
            where: {
              serviceName: additionalServices,
              channel: this.channel,
              userChannelId: this.userChannelId
            }
          })
          return {
            names: res.map(e => e.serviceName),
            ids: res.map(e => e.id)
          }
        }
        // get all subscribed services
        let res = await Subscription.find({
          fields: ['id', 'serviceName'],
          where: {
            userChannelId: this.userChannelId,
            channel: this.channel,
            state: 'confirmed'
          }
        })
        return {
          names: res.map(e => e.serviceName),
          ids: res.map(e => e.id)
        }
      }
    }
    let data = await getAdditionalServiceIds()
    await unsubscribeItems(
      {
        id: {
          inq: [].concat(this.id, data.ids)
        }
      },
      data
    )
  }

  Subscription.prototype.verify = function(options, confirmationCode, cb) {
    Subscription.getMergedConfig(
      'subscription',
      this.serviceName,
      (configErr, mergedSubscriptionConfig) => {
        if (configErr) {
          return cb(configErr)
        }

        function handleConfirmationAcknowledgement(err, message) {
          if (!mergedSubscriptionConfig.confirmationAcknowledgements) {
            return cb(err, message)
          }
          var redirectUrl =
            mergedSubscriptionConfig.confirmationAcknowledgements.redirectUrl
          if (redirectUrl) {
            if (err) {
              redirectUrl += '?err=' + encodeURIComponent(err.toString())
            }
            return options.httpContext.res.redirect(redirectUrl)
          } else {
            options.httpContext.res.setHeader('Content-Type', 'text/plain')
            if (err) {
              if (err.status) {
                options.httpContext.res.status(err.status)
              }
              return options.httpContext.res.end(
                mergedSubscriptionConfig.confirmationAcknowledgements
                  .failureMessage
              )
            }
            return options.httpContext.res.end(
              mergedSubscriptionConfig.confirmationAcknowledgements
                .successMessage
            )
          }
        }

        if (
          this.state !== 'unconfirmed' ||
          confirmationCode !== this.confirmationRequest.confirmationCode
        ) {
          var error = new Error('Forbidden')
          error.status = 403
          return handleConfirmationAcknowledgement(error)
        }
        this.state = 'confirmed'
        Subscription.replaceById(this.id, this, options, function(err, res) {
          return handleConfirmationAcknowledgement(err, 'OK')
        })
      }
    )
  }

  Subscription.prototype.unDeleteItemById = function(
    options,
    unsubscriptionCode,
    cb
  ) {
    if (!Subscription.isAdminReq(options.httpContext)) {
      if (
        this.unsubscriptionCode &&
        unsubscriptionCode !== this.unsubscriptionCode
      ) {
        let error = new Error('Forbidden')
        error.status = 403
        return cb(error)
      }
      if (
        Subscription.getCurrentUser(options.httpContext) ||
        this.state !== 'deleted'
      ) {
        let error = new Error('Forbidden')
        error.status = 403
        return cb(error)
      }
    }
    let revertItems = query => {
      Subscription.updateAll(
        query,
        {
          state: 'confirmed'
        },
        options,
        function(writeErr, res) {
          Subscription.getMergedConfig(
            'subscription',
            res.serviceName,
            (configErr, mergedSubscriptionConfig) => {
              var err = writeErr || configErr
              var anonymousUndoUnsubscription =
                mergedSubscriptionConfig.anonymousUndoUnsubscription
              if (anonymousUndoUnsubscription.redirectUrl) {
                var redirectUrl = anonymousUndoUnsubscription.redirectUrl
                if (err) {
                  redirectUrl += '?err=' + encodeURIComponent(err)
                }
                return options.httpContext.res.redirect(redirectUrl)
              } else {
                options.httpContext.res.setHeader('Content-Type', 'text/plain')
                if (err) {
                  return options.httpContext.res.end(
                    anonymousUndoUnsubscription.failureMessage
                  )
                }
                return options.httpContext.res.end(
                  anonymousUndoUnsubscription.successMessage
                )
              }
            }
          )
        }
      )
    }
    if (!this.unsubscribedAdditionalServices) {
      return revertItems({
        id: this.id
      })
    }
    let unsubscribedAdditionalServicesIds = this.unsubscribedAdditionalServices.ids.slice()
    this.unsetAttribute('unsubscribedAdditionalServices')
    Subscription.replaceById(this.id, this, options, (err, res) => {
      return revertItems({
        or: [
          {
            id: {
              inq: unsubscribedAdditionalServicesIds
            }
          },
          {
            id: this.id
          }
        ]
      })
    })
  }

  Subscription.getSubscribedServiceNames = function(options, cb) {
    if (!Subscription.isAdminReq(options.httpContext)) {
      let error = new Error('Forbidden')
      error.status = 403
      return cb(error)
    }
    let subscriptionCollection = Subscription.getDataSource().connector.collection(
      Subscription.modelName
    )
    // distinct is db-dependent feature. MongoDB supports it
    if (typeof subscriptionCollection.distinct === 'function') {
      subscriptionCollection.distinct(
        'serviceName',
        {
          state: 'confirmed'
        },
        cb
      )
      return
    }
    Subscription.find(
      {
        fields: {
          serviceName: true
        },
        where: {
          state: 'confirmed'
        },
        order: 'serviceName ASC'
      },
      (err, data) => {
        if (err) {
          return cb(err)
        }
        if (!data || data.length === 0) {
          return cb()
        }
        let uniq = data.reduce((a, e) => {
          if (a.length === 0 || a[a.length - 1] !== e.serviceName) {
            a.push(e.serviceName)
          }
          return a
        }, [])
        return cb(null, uniq)
      }
    )
  }
}
