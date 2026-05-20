import express from "express";
import jwt from "jsonwebtoken";
import { auth, firestore, stripe, resend, jwtSecret, senderEmail, subscriptionPriceId } from "../config.js";

const router = express.Router();

// ----- INSTITUTION USER ROUTES -----
router.post("/admin/create-institution-user", async (req, res) => {
  try {
    const { email, password, fullname, institutionName, institutionDomain, pricePerSeat } = req.body;

    if (!email || !password || !fullname || !institutionName || !institutionDomain) {
      return res.status(400).json({ error: "All fields are required: email, password, fullname, institutionName, institutionDomain" });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Validate pricePerSeat if provided
    const resolvedPrice = pricePerSeat != null ? Number(pricePerSeat) : null;
    if (resolvedPrice !== null && (isNaN(resolvedPrice) || resolvedPrice <= 0)) {
      return res.status(400).json({ error: "pricePerSeat must be a positive number" });
    }

    // Create Firebase Auth user
    let firebaseUser;
    try {
      firebaseUser = await auth.createUser({
        email: email.toLowerCase(),
        password,
        displayName: fullname,
      });
    } catch (error) {
      if (error.code === "auth/email-already-exists") {
        return res.status(400).json({ error: "Email already in use" });
      }
      throw error;
    }

    // Create Stripe customer
    let stripeCustomer;
    try {
      stripeCustomer = await stripe.customers.create({
        email: email.toLowerCase(),
        metadata: { user_auth_id: firebaseUser.uid },
      });
    } catch (error) {
      // Rollback: delete Firebase user
      await auth.deleteUser(firebaseUser.uid);
      throw error;
    }

    // Create Firestore user profile
    try {
      await firestore.collection("users_profiles").add({
        id: firebaseUser.uid,
        fullname,
        email: email.toLowerCase(),
        stripe_customer_id: stripeCustomer.id,
        role: "user",
        accountType: "institution",
        emailVerified: true,
        recoveryEmailVerified: true,
        institutionName,
        institutionDomain: institutionDomain.toLowerCase(),
        createdAt: new Date(),
      });
    } catch (error) {
      // Rollback: delete Stripe customer and Firebase user
      await stripe.customers.del(stripeCustomer.id);
      await auth.deleteUser(firebaseUser.uid);
      throw error;
    }

    // Handle offered price — create or reuse a Stripe price and track it
    let offeredStripePriceId = null;
    if (resolvedPrice !== null) {
      try {
        offeredStripePriceId = await getOrCreateOfferedPrice(resolvedPrice, firebaseUser.uid);
      } catch (priceError) {
        // Non-fatal: user is created, just log the pricing error
        console.error("Failed to set offered price:", priceError);
      }
    }

    return res.status(201).json({
      message: "Institution user created successfully",
      user: {
        uid: firebaseUser.uid,
        email: email.toLowerCase(),
        fullname,
        institutionName,
        institutionDomain: institutionDomain.toLowerCase(),
        offeredStripePriceId,
      },
    });
  } catch (error) {
    console.error("Error creating institution user:", error);
    return res.status(500).json({ error: "Failed to create institution user" });
  }
});

router.post("/delete-user", async (req, res) => {
  const { userUid } = req.body;

  try {
    await auth.deleteUser(userUid);
  } catch (error) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }

  return res.status(200).json({ message: "User deleted successfully" });
});

// Admin: Change user email
router.post("/admin/change-email", async (req, res) => {
  try {
    const { userUid, newEmail, firestoreDocId } = req.body;

    if (!userUid || !newEmail || !firestoreDocId) {
      return res.status(400).json({ error: "userUid, newEmail, and firestoreDocId are required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Check if email is already in use
    try {
      const existing = await auth.getUserByEmail(newEmail.toLowerCase());
      if (existing.uid !== userUid) {
        return res.status(400).json({ error: "This email is already in use by another account" });
      }
    } catch (err) {
      // auth/user-not-found means the email is available — that's fine
      if (err.code !== "auth/user-not-found") throw err;
    }

    // Update Firebase Auth
    await auth.updateUser(userUid, { email: newEmail.toLowerCase() });

    // Update Firestore
    const userDocRef = firestore.collection("users_profiles").doc(firestoreDocId);
    const userDoc = await userDocRef.get();
    await userDocRef.update({ email: newEmail.toLowerCase() });

    // Update Stripe customer email if exists
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.stripe_customer_id) {
        try {
          await stripe.customers.update(userData.stripe_customer_id, {
            email: newEmail.toLowerCase(),
          });
        } catch (stripeErr) {
          console.error("Failed to update Stripe customer email:", stripeErr);
        }
      }
    }

    return res.status(200).json({ message: "Email updated successfully" });
  } catch (error) {
    console.error("Error in admin/change-email:", error);
    return res.status(500).json({ error: "Failed to change email" });
  }
});

// Admin: Reset user password
router.post("/admin/reset-password", async (req, res) => {
  try {
    const { userUid, newPassword } = req.body;

    if (!userUid || !newPassword) {
      return res.status(400).json({ error: "userUid and newPassword are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    await auth.updateUser(userUid, { password: newPassword });

    return res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Error in admin/reset-password:", error);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});
export default router;
