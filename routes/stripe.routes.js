import express from "express";
import jwt from "jsonwebtoken";
import { auth, firestore, stripe, resend, jwtSecret, senderEmail, subscriptionPriceId } from "../config.js";
import { getDiscount } from "./coupon.routes.js";
import { getOrCreateOfferedPrice } from "./institution.routes.js";

const router = express.Router();

// ----- CUSTOMER ROUTES -----
router.post("/create-customer", async (req, res) => {
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
router.post("/delete-stripe-customer", async (req, res) => {
  const { customerId } = req.body;
  try {
    await stripe.customers.del(customerId);
    return res
      .status(200)
      .json({ message: "Stripe customer deleted successfully" });
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(`Stripe customer ${customerId} not found, proceeding anyway.`);
      return res.status(200).json({ message: "Stripe customer not found, but proceeding with deletion" });
    }
    console.error("Error deleting stripe customer:", error);
    return res.status(500).json({ error: "Failed to delete stripe customer" });
  }
});

// ----- SUBSCRIPTION ROUTES -----
router.get("/subscription-status/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;
    console.log(customerId);

    // Try active/trialing subscriptions first, fallback to all
    let subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "trialing",
        limit: 1,
      });
    }

    if (subscriptions.data.length === 0) {
      subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 1,
      });
    }

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
      trialEnd: subscription.trial_end || null, // Trial end timestamp
      planName: product.name || "Unknown Plan",
      subscriptionId: subscription.id,
      seatCount: subscription.items.data[0]?.quantity || 1,
    });
  } catch (error) {
    console.error("Error fetching subscription status:", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch subscription status" });
  }
});

router.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, customerId } = req.body;
    const emailDomain = email.split("@")[1];
    const coupons = await stripe.coupons.list({ limit: 100 });

    const discount = getDiscount(coupons.data, email, emailDomain);

    // Check for existing subscriptions (including canceled ones)
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });

    // Check if user has an active or trialing subscription
    const hasActiveSubscription = existingSubscriptions.data.some(
      (sub) => sub.status === "active" || sub.status === "trialing"
    );

    if (hasActiveSubscription) {
      return res.status(400).json({
        error:
          "You already have an active subscription. Please cancel it first or manage it in your account settings.",
        sessionUrl: null,
      });
    }

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
      success_url: process.env.FRONTEND_URL + "/dashboard",
      cancel_url: process.env.FRONTEND_URL + "/pricing?error=true",
    };

    if (discount && discount.percent_off === 100 && discount.duration === "forever") {
      try {
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: subscriptionPriceId }],
          discounts: [{ coupon: discount.id }],
        });

        if (subscription.status === "active" || subscription.status === "trialing") {
          return res.status(200).json({ bypassedCheckout: true, subscriptionId: subscription.id });
        }
      } catch (subError) {
        console.error("Failed to directly create subscription for 100% off coupon:", subError);
        // Fallback to normal checkout session
      }
    }

    if (discount) {
      checkoutParams.discounts = [
        {
          coupon: discount.id,
        },
      ];
    }

    const session = await stripe.checkout.sessions.create(checkoutParams);
    return res.status(200).json({ sessionUrl: session.url });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return res.status(500).json({ sessionUrl: null, error: error.message });
  }
});

// GET endpoint: look up the offered price for an institution user by their Firebase UID
router.get("/institution/offered-price/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    const snapshot = await firestore
      .collection("offered_prices")
      .where("offered_to", "array-contains", uid)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Fall back to creating a default $2.50 price specifically for them
      const stripePriceId = await getOrCreateOfferedPrice(2.5, uid);
      return res.status(200).json({
        stripe_price_id: stripePriceId,
        price_per_seat: 2.5,
        isDefault: false,
      });
    }

    const data = snapshot.docs[0].data();
    return res.status(200).json({
      stripe_price_id: data.stripe_price_id,
      price_per_seat: data.price_per_seat,
      isDefault: false,
    });
  } catch (error) {
    console.error("Error fetching offered price:", error);
    return res.status(500).json({ error: "Failed to fetch offered price" });
  }
});

router.post("/create-institution-checkout-session", async (req, res) => {
  try {
    const { customerId, quantity, priceId } = req.body;

    if (!customerId || !quantity || quantity < 1) {
      return res.status(400).json({ error: "Customer ID and quantity (>= 1) are required" });
    }

    // Use the provided custom price or fall back to the default institution price
    const resolvedPriceId = priceId || "price_1T85NVFG6H6jDaislxpmNNBP";

    // Check for existing subscriptions
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });

    const hasActiveSubscription = existingSubscriptions.data.some(
      (sub) => sub.status === "active" || sub.status === "trialing"
    );

    if (hasActiveSubscription) {
      return res.status(400).json({
        error: "You already have an active subscription.",
        sessionUrl: null,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: resolvedPriceId,
          quantity: parseInt(quantity),
        },
      ],
      customer: customerId,
      success_url: process.env.FRONTEND_URL + "/institution-portal",
      cancel_url: process.env.FRONTEND_URL + "/institution-pricing?error=true",
    });

    return res.status(200).json({ sessionUrl: session.url });
  } catch (error) {
    console.error("Error creating institution checkout session:", error);
    return res.status(500).json({ sessionUrl: null, error: error.message });
  }
});
export default router;
