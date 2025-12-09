import express from "express";
import { Resend } from "resend";
import cors from "cors";
import Stripe from "stripe";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import dotenv from "dotenv";
dotenv.config();

// App config
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
  })
);

const resendApiKey = process.env.RESEND_API_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const senderEmail = process.env.SENDER_EMAIL;
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
const nodeEnv = process.env.NODE_ENV;
const subscriptionPriceId =
  nodeEnv === "production"
    ? process.env.SUBSCRIPTION_PRICE_ID
    : "price_1SVczaFG6H6jDaisbaA2rmbz";

if (!subscriptionPriceId) {
  throw new Error("Please define SUBSCRIPTION_PRICE_ID in .env");
}

if (!firebaseServiceAccount) {
  throw new Error("Please define FIREBASE_SERVICE_ACCOUNT in .env");
}
if (!resendApiKey) {
  throw new Error("Please define RESEND_API_KEY in .env");
}
if (!senderEmail) {
  throw new Error("Please define SENDER_EMAIL in .env");
}
if (!stripeSecretKey) {
  throw new Error("Please define STRIPE_SECRET_KEY in .env");
}

const resend = new Resend(resendApiKey);
const stripe = new Stripe(stripeSecretKey);
const firebaseApp = initializeApp({
  credential: cert(JSON.parse(firebaseServiceAccount)),
});
const auth = getAuth(firebaseApp);

// ----- USER ROUTES -----
app.post("/send-email", async (req, res) => {
  const payload = req.body;
  console.log(payload);

  if (!Array.isArray(payload.emailObjects) || payload.emailObjects.length < 1) {
    return res
      .status(400)
      .json({ error: "Please provide list of emails to send email to" });
  }

  const emails = payload.emailObjects.map((obj) => {
    return {
      from: senderEmail,
      to: obj.email,
      subject: "Research Paper Invitation",
      text: `${obj.invitedBy} added you as a co-author of the work "${obj.paper}" with the following contribution: ${obj.contributions}. If you want to check the status of the publication, please follow this link <NO LINK YET>`,
    };
  });

  const responses = await resend.batch.send(emails);
  console.log(responses.data);

  return res.status(200).json({ message: "Emails has been sent" });
});
app.post("/delete-user", async (req, res) => {
  const { userUid } = req.body;

  try {
    await auth.deleteUser(userUid);
  } catch (error) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }

  return res.status(200).json({ message: "User deleted successfully" });
});

// ----- CUSTOMER ROUTES -----
app.post("/create-customer", async (req, res) => {
  const payload = req.body;
  console.log(payload);

  const customer = await stripe.customers.create({
    email: payload.email,
    metadata: {
      user_auth_id: payload.auth_id,
    },
  });

  return res.status(200).json({ customerId: customer.id });
});
app.post("/delete-stripe-customer", async (req, res) => {
  const { customerId } = req.body;
  try {
    await stripe.customers.del(customerId);
    return res
      .status(200)
      .json({ message: "Stripe customer deleted successfully" });
  } catch (error) {
    console.error("Error deleting stripe customer:", error);
    return res.status(500).json({ error: "Failed to delete stripe customer" });
  }
});

// ----- SUBSCRIPTION ROUTES -----
app.get("/subscription-status/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;
    console.log(customerId);

    // Get all subscriptions for the customer
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 1,
    });
    console.log(subscriptions.data);

    if (subscriptions.data.length === 0) {
      return res.status(200).json({
        hasSubscription: false,
        status: null,
        currentPeriodEnd: null,
        planName: null,
      });
    }

    const subscription = subscriptions.data[0];
    const priceId = subscription.items.data[0]?.price.id;
    const price = await stripe.prices.retrieve(priceId);
    const product = await stripe.products.retrieve(price.product);

    return res.status(200).json({
      hasSubscription: true,
      status: subscription.status,
      currentPeriodEnd: subscription.items.data[0].current_period_end,
      planName: product.name || "Unknown Plan",
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("Error fetching subscription status:", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch subscription status" });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  const { email, customerId } = req.body;
  const emailDomain = email.split("@")[1];
  const coupons = await stripe.coupons.list({ limit: 100 });

  const discount = getDiscount(coupons.data, email, emailDomain);

  const checkoutParams = {
    payment_method_types: ["card"],
    mode: "subscription",
    line_items: [
      {
        price: subscriptionPriceId,
        quantity: 1,
      },
    ],
    customer: customerId,
    success_url: process.env.FRONTEND_URL,
    cancel_url: process.env.FRONTEND_URL + "/pricing?error=true",
  };

  if (discount) {
    checkoutParams.discounts = [
      {
        coupon: discount.id,
      },
    ];
  }

  try {
    const session = await stripe.checkout.sessions.create(checkoutParams);
    return res.status(200).json({ sessionUrl: session.url });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return res.status(500).json({ sessionUrl: null });
  }
});

// ----- COUPONS ROUTES -----
app.get("/coupons", async (req, res) => {
  try {
    const coupons = await stripe.coupons.list({ limit: 100 });
    return res.status(200).json(coupons.data);
  } catch (error) {
    console.error("Error fetching coupons:", error);
    return res.status(500).json([]);
  }
});

app.post("/coupons", async (req, res) => {
  try {
    const { name, domain, discountPercent, maxSeats, expiresAt } = req.body;

    // Convert date string to Unix timestamp (seconds)
    const redeemBy = expiresAt
      ? Math.floor(new Date(expiresAt).getTime() / 1000)
      : undefined;

    const coupon = await stripe.coupons.create({
      percent_off: Number(discountPercent),
      duration: "forever",
      max_redemptions: Number(maxSeats),
      redeem_by: redeemBy,
      name: name,
      metadata: {
        allowed_domain: domain,
      },
    });

    return res.status(201).json(coupon);
  } catch (error) {
    console.error("Error creating coupon:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/manual-override-coupons", async (req, res) => {
  try {
    const { name, email, discountPercent, expiresAt } = req.body;

    // Convert date string to Unix timestamp (seconds)
    const redeemBy = expiresAt
      ? Math.floor(new Date(expiresAt).getTime() / 1000)
      : undefined;

    const coupon = await stripe.coupons.create({
      percent_off: Number(discountPercent),
      duration: "forever",
      max_redemptions: 1,
      redeem_by: redeemBy,
      name: name,
      metadata: {
        allowed_email: email,
      },
    });

    return res.status(201).json(coupon);
  } catch (error) {
    console.error("Error creating manual override coupon:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/coupons/:couponId", async (req, res) => {
  try {
    const { couponId } = req.params;

    await stripe.coupons.del(couponId);

    return res.status(200).json({ message: "Coupon deleted successfully" });
  } catch (error) {
    console.error("Error deleting coupon:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/coupons/bulk", async (req, res) => {
  try {
    const { coupons } = req.body;

    if (!Array.isArray(coupons) || coupons.length === 0) {
      return res.status(400).json({
        error: "Please provide an array of coupons",
      });
    }

    let created = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < coupons.length; i++) {
      const coupon = coupons[i];
      try {
        // Convert date string to Unix timestamp (seconds)
        const redeemBy = coupon.expiresAt
          ? Math.floor(new Date(coupon.expiresAt).getTime() / 1000)
          : undefined;

        if (coupon.type === "domain") {
          // Create domain coupon
          await stripe.coupons.create({
            percent_off: Number(coupon.discountPercent),
            duration: "forever",
            max_redemptions: Number(coupon.maxSeats),
            redeem_by: redeemBy,
            name: coupon.name,
            metadata: {
              allowed_domain: coupon.domain,
            },
          });
          created++;
        } else if (coupon.type === "email") {
          // Create email coupon
          await stripe.coupons.create({
            percent_off: Number(coupon.discountPercent),
            duration: "forever",
            max_redemptions: 1,
            redeem_by: redeemBy,
            name: coupon.name,
            metadata: {
              allowed_email: coupon.email,
            },
          });
          created++;
        } else {
          throw new Error(`Invalid coupon type: ${coupon.type}`);
        }
      } catch (error) {
        failed++;
        errors.push({
          row: i + 1,
          coupon: coupon.name || `Row ${i + 1}`,
          error: error.message,
        });
        console.error(`Error creating coupon at row ${i + 1}:`, error);
      }
    }

    return res.status(200).json({
      created,
      failed,
      total: coupons.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error creating bulk coupons:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/discounts", async (req, res) => {
  const { email } = req.body;
  const emailDomain = email.split("@")[1];
  const coupons = await stripe.coupons.list({ limit: 100 });

  const discount = getDiscount(coupons.data, email, emailDomain);

  if (!discount || discount.max_redemptions === discount.times_redeemed) {
    return res.status(200).json({ discount: null });
  }

  return res.status(200).json({
    discount: {
      discount: discount.percent_off / 100,
      domain: discount.metadata.allowed_domain,
    },
  });
});

// -------- HELPER FUNCTION -----------
function getDiscount(coupons, email, domain) {
  // 1. Filter email and domain coupons
  const emailCoupons = coupons.filter(
    (c) => c.metadata.allowed_email === email
  );
  const domainCoupons = coupons.filter(
    (c) => c.metadata.allowed_domain === domain
  );

  // 2. If user have an email coupon return it
  //    otherwise, check for a domain based coupon
  const emailDiscount = emailCoupons.find(
    (c) => c.metadata.allowed_email === email
  );
  if (emailDiscount) {
    return emailDiscount;
  }

  const domainDiscount = domainCoupons.find(
    (c) => c.metadata.allowed_domain === domain
  );
  if (domainDiscount) {
    return domainDiscount;
  }

  // 3. If no discounts are available, return null (fallback to normal price)
  return null;
}

// app.post("/cancel-subscription", async (req, res) => {
//   try {
//     const { subscriptionId } = req.body;

//     if (!subscriptionId) {
//       return res.status(400).json({ error: "subscriptionId is required" });
//     }

//     const subscription = await stripe.subscriptions.cancel(subscriptionId);

//     return res.status(200).json({
//       message: "Subscription cancelled successfully",
//       status: subscription.status,
//     });
//   } catch (error) {
//     console.error("Error cancelling subscription:", error);
//     return res.status(500).json({ error: "Failed to cancel subscription" });
//   }
// });

app.listen(3000, () => console.log("Listening on 3000"));
