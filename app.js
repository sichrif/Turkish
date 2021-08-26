require('dotenv').config()
require('./src/connect/mongodb')
const bodyParser = require('body-parser')
const express = require('express')
const bcrypt= require('bcrypt')
var jwt = require("jsonwebtoken");
const session = require('express-session')
var MemoryStore = require('memorystore')(session)
const UserService = require('./src/user')
const Stripe = require('./src/connect/stripe')
const setCurrentUser = require('./src/middleware/setCurrentUser')
const hasPlan = require('./src/middleware/hasPlan')
const User = require("./src/user/user.model");
const auth = require("./src/middleware/auth");

const app = express()
app.use(session({
  saveUninitialized: false,
  cookie: { maxAge: 86400000 },
  store: new MemoryStore({
    checkPeriod: 86400000 // prune expired entries every 24h
  }),
  resave: false,
  secret: 'keyboard cat'
}))

app.use('/webhook', bodyParser.raw({ type: 'application/json' }))

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

app.use(express.static('public'))
app.engine('html', require('ejs').renderFile)

const productToPriceMap = {
  basic: process.env.PRODUCT_BASIC,
  pro: process.env.PRODUCT_PRO
}

app.get('/none',auth, [setCurrentUser, hasPlan('none')], async function (
  req,
  res,
  next
) {
  res.status(200).render('none.ejs')
})

app.get('/basic', [setCurrentUser, hasPlan('basic')], async function (
  req,
  res,
  next
) {
  res.status(200).render('basic.ejs')
})

app.get('/pro', [setCurrentUser, hasPlan('pro')], async function (
  req,
  res,
  next
) {
  res.status(200).render('pro.ejs')
})

app.get('/', function (req, res) {
  res.render('login.ejs')
})

app.get('/account', async function (req, res) {
  let { email } = req.session
  let customer = await UserService.getUserByEmail(email)
  if (!customer) {
    res.redirect('/')
  } else {
    res.render('account.ejs', { customer })
  }
})
app.post("/register",async function  (req, res)  {
  let { email } = req.session

  let customer = await UserService.getUserByEmail(email)
  let customerInfo = {}
  console.log(`email ${email} does not exist. Making one. `)
  // our register logic goes here...
   // Our register logic starts here
   try {
    // Get user input
    const { name, email, password } = req.body;

    // Validate user input
    if (!(email && password && name)) {
      res.status(400).send("All input is required");
    }

    // check if user already exist
    // Validate if user exist in our database
    const oldUser = await User.findOne({ email });

    if (oldUser) {
      return res.status(409).send("User Already Exist. Please Login");
    }

    //Encrypt user password
    encryptedPassword = await bcrypt.hash(password, 10);

    // Create user in our database
  
    customerInfo = await Stripe.addNewCustomer(email)

    customer = await UserService.addUser({
      name,
      email: customerInfo.email.toLowerCase(),
      password: encryptedPassword,
      billingID: customerInfo.id,
      plan: 'none',
      endDate: null
    })

    // Create token
    const token = jwt.sign(
      { user_id: customerInfo.id, email },
      process.env.TOKEN_KEY,
      {
        expiresIn: "24h",
      }
    );
    // save user token
    customer.token = token;
    console.log(
      `A new user signed up and addded to DB. The ID for ${email} is ${JSON.stringify(
        customerInfo
      )}`
    )

    console.log(`User also added to DB. Information from DB: ${customer}`)
    customerInfo = await Stripe.getCustomerByID(customer.billingID)
    console.log(
      `The existing ID for ${email} is ${JSON.stringify(customerInfo)}`
    )
   // res.redirect('/account')

    // return new user
    res.status(201).json(user);
  } catch (err) {
    console.log(err);
  }
  });
app.post('/login', async function (req, res) {
  try {
    

  const { email, password } = req.body;

  let customer = await UserService.getUserByEmail(email)
  let customerInfo = {}
console.log(customer)
  if (customer) {
    if (!(email && password)) {
      res.status(400).send("All input is required");
    }
    const isTrialExpired =
      customer.plan != 'none' && customer.endDate < new Date().getTime()

      const user = await User.findOne({ email });

      if (user && (await bcrypt.compare(password, user.password))) {
        // Create token
        const token = jwt.sign(
          { user_id: user._id, email },
          process.env.TOKEN_KEY,
          {
            expiresIn: "2h",
          }
        );
  
        // save user token
        user.token = token;
        if (isTrialExpired) {
          console.log('trial expired')
          customer.hasTrial = false
          customer.save()
        } else {
          console.log(
            'no trial information',
            customer.hasTrial,
            customer.plan != 'none',
            customer.endDate < new Date().getTime()
          )
        }
        // user

        customerInfo = await Stripe.getCustomerByID(customer.billingID)
        console.log(
          `The existing ID for ${email} is ${JSON.stringify(customerInfo)}`
        )
     res.status(200).json(user);
     // res.redirect('/account')

      }else{
        res.status(400).send("Invalid Credentials");
      }


      
   


    res.redirect('/account')

  } else {
    res.status(400)
    return res.send({
      error: {
        message: "go register "
      }
    })
   }
  } catch (error) {
    console.log(error);
  }



})

app.post('/checkout', setCurrentUser, async (req, res) => {
  const customer = req.user
  const { product, customerID } = req.body

  const price = productToPriceMap[product]

  try {
    const session = await Stripe.createCheckoutSession(customerID, price)

    const ms =
      new Date().getTime() + 1000 * 60 * 60 * 24 * process.env.TRIAL_DAYS
    const n = new Date(ms)

    customer.plan = product
    customer.hasTrial = true
    customer.endDate = n
    customer.save()

    res.send({
      sessionId: session.id
    })
  } catch (e) {
    console.log(e)
    res.status(400)
    return res.send({
      error: {
        message: e.message
      }
    })
  }
})

app.post('/billing', setCurrentUser, async (req, res) => {
  const { customer } = req.body
  console.log('customer', customer)

  const session = await Stripe.createBillingSession(customer)
  console.log('session', session)

  res.json({ url: session.url })
})

app.post('/webhook', async (req, res) => {
  let event

  try {
    event = Stripe.createWebhook(req.body, req.header('Stripe-Signature'))
  } catch (err) {
    console.log(err)
    return res.sendStatus(400)
  }

  const data = event.data.object

  console.log(event.type, data)
  switch (event.type) {
    case 'customer.created':
      console.log(JSON.stringify(data))
      break
    case 'invoice.paid':
      break
    case 'customer.subscription.created': {
      const user = await UserService.getUserByBillingID(data.customer)

      if (data.plan.id === process.env.PRODUCT_BASIC) {
        console.log('You are talking about basic product')
        user.plan = 'basic'
      }

      if (data.plan.id === process.env.PRODUCT_PRO) {
        console.log('You are talking about pro product')
        user.plan = 'pro'
      }

      user.hasTrial = true
      user.endDate = new Date(data.current_period_end * 1000)

      await user.save()

      break
    }
    case 'customer.subscription.updated': {
      // started trial
      const user = await UserService.getUserByBillingID(data.customer)

      if (data.plan.id == process.env.PRODUCT_BASIC) {
        console.log('You are talking about basic product')
        user.plan = 'basic'
      }

      if (data.plan.id === process.env.PRODUCT_PRO) {
        console.log('You are talking about pro product')
        user.plan = 'pro'
      }

      const isOnTrial = data.status === 'trialing'

      if (isOnTrial) {
        user.hasTrial = true
        user.endDate = new Date(data.current_period_end * 1000)
      } else if (data.status === 'active') {
        user.hasTrial = false
        user.endDate = new Date(data.current_period_end * 1000)
      }

      if (data.canceled_at) {
        // cancelled
        console.log('You just canceled the subscription' + data.canceled_at)
        user.plan = 'none'
        user.hasTrial = false
        user.endDate = null
      }
      console.log('actual', user.hasTrial, data.current_period_end, user.plan)

      await user.save()
      console.log('customer changed', JSON.stringify(data))
      break
    }
    default:
  }
  res.sendStatus(200)
})

const port = process.env.PORT || 4242

app.listen(port, () => console.log(`Listening on port ${port}!`))
