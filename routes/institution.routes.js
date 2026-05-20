import express from "express";
import jwt from "jsonwebtoken";
import { auth, firestore, stripe, resend, jwtSecret, senderEmail, subscriptionPriceId } from "../config.js";

const router = express.Router();

// ----- OFFERED PRICES HELPER -----
// Finds an existing offered_price doc with matching price_per_seat, or creates a new Stripe price
// and a new Firestore doc. Either way, appends `uid` to `offered_to`.
async function getOrCreateOfferedPrice(pricePerSeat, uid) {
  const offeredPricesRef = firestore.collection("offered_prices");

  // Look for an existing doc with the same price
  const existing = await offeredPricesRef
    .where("price_per_seat", "==", pricePerSeat)
    .limit(1)
    .get();

  if (!existing.empty) {
    // Reuse the existing Stripe price and append the new uid
    const docRef = existing.docs[0].ref;
    const data = existing.docs[0].data();
    await docRef.update({
      offered_to: [...(data.offered_to || []), uid],
    });
    return data.stripe_price_id;
  }

  // No existing price — create a new Stripe price.
  // Attach it to the same product as the default institution price.
  const defaultPrice = await stripe.prices.retrieve("price_1T85NVFG6H6jDaislxpmNNBP");
  const productId = defaultPrice.product;

  const newStripePrice = await stripe.prices.create({
    unit_amount: Math.round(pricePerSeat * 100), // convert dollars to cents
    currency: "usd",
    recurring: { interval: "month" },
    product: productId,
    metadata: { created_by: "dynamic_pricing" },
  });

  // Save to Firestore
  await offeredPricesRef.add({
    stripe_price_id: newStripePrice.id,
    price_per_seat: pricePerSeat,
    offered_to: [uid],
    createdAt: new Date(),
  });

  return newStripePrice.id;
}

// ----- INSTITUTION INVITATION ROUTES -----

// Get all invitations for an institution
router.get("/institution/invitations/:institutionUserId", async (req, res) => {
  try {
    const { institutionUserId } = req.params;
    const snapshot = await firestore
      .collection("institution_invitations")
      .where("institutionUserId", "==", institutionUserId)
      .get();

    const invitations = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .sort((a, b) => {
        const timeA = a.createdAt?._seconds || a.createdAt || 0;
        const timeB = b.createdAt?._seconds || b.createdAt || 0;
        return timeB - timeA;
      });

    return res.status(200).json({ invitations });
  } catch (error) {
    console.error("Error fetching invitations:", error);
    return res.status(500).json({ error: "Failed to fetch invitations" });
  }
});

// Invite a user
router.post("/institution/invite-user", async (req, res) => {
  try {
    const { institutionUserId, invitedEmail, institutionEmail, institutionName } = req.body;

    if (!institutionUserId || !invitedEmail || !institutionEmail) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get institution user profile to find stripe customer ID
    const usersRef = firestore.collection("users_profiles");
    const userSnapshot = await usersRef
      .where("id", "==", institutionUserId)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      return res.status(404).json({ error: "Institution user not found" });
    }

    const institutionProfile = userSnapshot.docs[0].data();
    const customerId = institutionProfile.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: "No Stripe customer found" });
    }

    // Get seat count from subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return res.status(400).json({ error: "No active subscription found" });
    }

    const seatCount = subscriptions.data[0].items.data[0]?.quantity || 1;

    // Count existing invitations
    const existingInvitations = await firestore
      .collection("institution_invitations")
      .where("institutionUserId", "==", institutionUserId)
      .get();

    if (existingInvitations.size >= seatCount) {
      return res.status(400).json({
        error: `All ${seatCount} seats are in use. Remove an invitation or upgrade your plan.`,
      });
    }

    // Check if email is already invited
    const alreadyInvited = existingInvitations.docs.some(
      (doc) => doc.data().invitedEmail === invitedEmail.toLowerCase()
    );

    if (alreadyInvited) {
      return res.status(400).json({ error: "This email has already been invited" });
    }

    // Create invitation
    const docRef = await firestore.collection("institution_invitations").add({
      institutionUserId,
      institutionEmail: institutionEmail.toLowerCase(),
      institutionName: institutionName || "",
      invitedEmail: invitedEmail.toLowerCase(),
      status: "pending",
      createdAt: new Date(),
    });

    // Send invitation email
    const institutionDisplayName = institutionName ? `${institutionName} (${institutionEmail.toLowerCase()})` : institutionEmail.toLowerCase();

    try {
      const resendResponse = await resend.emails.send({
        from: `Pipeline <${process.env.SENDER_EMAIL}>`,
        to: invitedEmail.toLowerCase(),
        subject: `You've been invited to join Pipeline by ${institutionName || "your institution"}!`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333 text-align: center;">
            <h2 style="color: #2563eb;">Pipeline Invitation</h2>
            <p>Hello!</p>
            <p>You have been invited by <strong>${institutionDisplayName}</strong> to join Pipeline. Your subscription is covered by your institution!</p>
            <p>Please click the link below to sign up and join your institution's portal:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/signup" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                Accept Invitation & Sign Up
              </a>
            </div>
            <p style="color: #666; font-size: 14px;">If you already have a Pipeline account with this email address, simply log in.</p>
          </div>
        `,
      });
      console.log("Resend API response:", resendResponse);
    } catch (emailError) {
      console.error("Failed to send invitation email via Resend:", emailError);
      // We don't return 500 here because the invitation was successfully created in the DB
    }


    return res.status(201).json({
      message: "Invitation sent successfully",
      invitation: {
        id: docRef.id,
        invitedEmail: invitedEmail.toLowerCase(),
        status: "pending",
      },
    });
  } catch (error) {
    console.error("Error inviting user:", error);
    return res.status(500).json({ error: "Failed to invite user" });
  }
});

// Revoke an invitation
router.post("/institution/revoke-invitation", async (req, res) => {
  try {
    const { invitationId } = req.body;

    if (!invitationId) {
      return res.status(400).json({ error: "Invitation ID is required" });
    }

    await firestore.collection("institution_invitations").doc(invitationId).delete();

    return res.status(200).json({ message: "Invitation revoked successfully" });
  } catch (error) {
    console.error("Error revoking invitation:", error);
    return res.status(500).json({ error: "Failed to revoke invitation" });
  }
});

// Check if a user email has institution coverage
router.get("/institution/check-coverage/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const snapshot = await firestore
      .collection("institution_invitations")
      .where("invitedEmail", "==", email.toLowerCase())
      .limit(10) // fetch a few just in case there are multiple, evaluate in memory
      .get();

    // Prefer accepted, otherwise look for pending
    let targetDoc = snapshot.docs.find(doc => doc.data().status === "accepted");

    // If no accepted one but there's a pending one, auto-accept it now since the user is explicitly checking coverage (meaning they are logged in)
    if (!targetDoc) {
      targetDoc = snapshot.docs.find(doc => doc.data().status === "pending");

      if (targetDoc) {
        // Auto-accept the invitation
        await targetDoc.ref.update({ status: "accepted" });
      }
    }

    if (!targetDoc) {
      return res.status(200).json({ covered: false });
    }

    const invitation = targetDoc.data();
    return res.status(200).json({
      covered: true,
      institutionName: invitation.institutionName,
    });
  } catch (error) {
    console.error("Error checking coverage:", error);
    return res.status(500).json({ error: "Failed to check coverage" });
  }
});

router.post("/cancel-subscription", async (req, res) => {
  try {
    const { subscriptionId } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({ error: "subscriptionId is required" });
    }

    // Cancel immediately - stripe.subscriptions.cancel() cancels immediately by default
    // To cancel at period end, use: stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
    const subscription = await stripe.subscriptions.cancel(subscriptionId);

    return res.status(200).json({
      message: "Subscription cancelled successfully",
      status: subscription.status,
    });
  } catch (error) {
    console.error("Error cancelling subscription:", error.message);
    return res
      .status(500)
      .json({ error: error.message || "Failed to cancel subscription" });
  }
});
export default router;
