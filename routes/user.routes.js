import express from "express";
import jwt from "jsonwebtoken";
import { auth, firestore, stripe, resend, jwtSecret, senderEmail, subscriptionPriceId } from "../config.js";

const router = express.Router();

// ----- USER ROUTES -----
router.post("/verify-token", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    // Verify and decode the JWT token
    const decoded = jwt.verify(token, jwtSecret);

    if (!decoded || !decoded.email) {
      return res.status(400).json({ error: "Invalid token" });
    }

    return res.status(200).json({ email: decoded.email });
  } catch (error) {
    console.error("Error verifying token:", error);
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token has expired" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    return res.status(500).json({ error: "Failed to verify token" });
  }
});

router.post("/send-email", async (req, res) => {
  const payload = req.body;
  console.log(payload);

  if (!Array.isArray(payload.emailObjects) || payload.emailObjects.length < 1) {
    return res
      .status(400)
      .json({ error: "Please provide list of emails to send email to" });
  }

  const emails = payload.emailObjects.map((obj) => {
    // Generate JWT token containing the collaborator's email
    // No expiration - token never expires
    const token = jwt.sign({ email: obj.email }, jwtSecret);

    // Create the link with the JWT token
    const viewLink = `${process.env.FRONTEND_URL}/view/collaborator-papers?token=${token}`;

    // HTML email content with clickable link
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <!-- Header with Logo -->
        <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
          <div style="text-align: center;">
            <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
          </div>
        </div>
        
        <!-- Email Content -->
        <div style="padding: 0 20px;">
          <p>Hello,</p>
          <p><strong>${obj.invitedBy}</strong> added you as a co-author of the work <strong>"${obj.paper}"</strong> with the following contribution: <strong>${obj.contributions}</strong>.</p>
          <p>If you want to check the status of the publication, please click the link below:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${viewLink}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold;">View Paper Status</a>
          </div>
          <p style="font-size: 12px; color: #666; margin-top: 30px;">If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="font-size: 12px; color: #2563eb; word-break: break-all;">${viewLink}</p>
        </div>
      </div>
    `;

    return {
      from: senderEmail,
      to: obj.email,
      subject: "You've been added as co-author in Pipeline",
      html: htmlContent,
    };
  });

  const responses = await resend.batch.send(emails);
  console.log(responses.data);

  return res.status(200).json({ message: "Emails has been sent" });
});
router.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Validate user exists in Firebase Auth
    try {
      await auth.getUserByEmail(email);
    } catch (error) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const otpDocRef = firestore.collection("otps").doc(email.toLowerCase());
    await otpDocRef.set({
      otp,
      expiresAt,
      createdAt: new Date(),
    });

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
          <div style="text-align: center;">
            <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
          </div>
        </div>
        <div style="padding: 0 20px;">
          <p>Hello,</p>
          <p>Your login verification code is: <strong style="font-size: 24px;">${otp}</strong></p>
          <p>This code will expire in 10 minutes.</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: senderEmail,
      to: email,
      subject: "Your Pipeline Verification Code",
      html: htmlContent,
    });

    return res.status(200).json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Error sending OTP:", error);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    const otpDocRef = firestore.collection("otps").doc(email.toLowerCase());
    const snapshot = await otpDocRef.get();

    if (!snapshot.exists) {
      return res.status(400).json({ error: "No pending verification found or code is invalid." });
    }

    const data = snapshot.data();
    if (data.otp !== otp) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    if (data.expiresAt.toDate() < new Date()) {
      await otpDocRef.delete();
      return res.status(400).json({ error: "Verification code has expired. Please request a new one." });
    }

    // Valid OTP, delete it
    await otpDocRef.delete();

    // If this is for email verification after signup, mark the email as verified
    if (purpose === "email-verification") {
      const usersRef = firestore.collection("users_profiles");
      const userSnapshot = await usersRef.where("email", "==", email.toLowerCase()).limit(1).get();
      if (!userSnapshot.empty) {
        await userSnapshot.docs[0].ref.update({ emailVerified: true });
      }
    }

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    return res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// ----- FORGOT PASSWORD ROUTES -----
router.post("/forgot-password", async (req, res) => {
  try {
    const { email, useRecoveryEmail } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Check if user exists in Firebase
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (error) {
      // Don't reveal whether the email exists or not
      return res
        .status(200)
        .json({ message: "If an account exists with this email, a password reset link has been sent." });
    }

    // Determine the target email address
    let targetEmail = email;

    if (useRecoveryEmail) {
      const usersRef = firestore.collection("users_profiles");
      const snapshot = await usersRef.where("email", "==", email).limit(1).get();

      if (snapshot.empty || !snapshot.docs[0].data().recoveryEmail) {
        return res.status(400).json({ error: "No recovery email found for this account." });
      }

      targetEmail = snapshot.docs[0].data().recoveryEmail;
    }

    // Generate JWT with 1 hour expiry (always contains primary email)
    const token = jwt.sign({ email: userRecord.email }, jwtSecret, {
      expiresIn: "1h",
    });

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <!-- Header with Logo -->
        <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
          <div style="text-align: center;">
            <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
          </div>
        </div>

        <!-- Email Content -->
        <div style="padding: 0 20px;">
          <p>Hello,</p>
          <p>We received a request to reset your password for your Pipeline account.</p>
          <p>Click the button below to set a new password. This link will expire in 1 hour.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
          </div>
          <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.</p>
          <p style="font-size: 12px; color: #666; margin-top: 30px;">If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="font-size: 12px; color: #2563eb; word-break: break-all;">${resetLink}</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: senderEmail,
      to: targetEmail,
      subject: "Reset your Pipeline password",
      html: htmlContent,
    });

    return res
      .status(200)
      .json({ message: "If an account exists with this email, a password reset link has been sent." });
  } catch (error) {
    console.error("Error in forgot-password:", error);
    return res.status(500).json({ error: "Failed to process password reset request" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Reset link has expired. Please request a new one." });
      }
      return res.status(401).json({ error: "Invalid reset link." });
    }

    if (!decoded || !decoded.email) {
      return res.status(401).json({ error: "Invalid reset link." });
    }

    // Find user by email and update password
    const userRecord = await auth.getUserByEmail(decoded.email);
    await auth.updateUser(userRecord.uid, { password: newPassword });

    return res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error in reset-password:", error);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

// ----- RECOVERY EMAIL OTP ROUTES -----
router.post("/send-recovery-otp", async (req, res) => {
  try {
    const { email, recoveryEmail } = req.body;

    if (!email || !recoveryEmail) {
      return res.status(400).json({ error: "Email and recovery email are required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recoveryEmail)) {
      return res.status(400).json({ error: "Invalid recovery email format" });
    }

    if (email.toLowerCase() === recoveryEmail.toLowerCase()) {
      return res.status(400).json({ error: "Recovery email must be different from your primary email" });
    }

    // Check if this recovery email is already verified by another user
    const usersRef = firestore.collection("users_profiles");
    const existingSnapshot = await usersRef
      .where("recoveryEmail", "==", recoveryEmail.toLowerCase())
      .where("recoveryEmailVerified", "==", true)
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      const existingUser = existingSnapshot.docs[0].data();
      if (existingUser.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({ error: "This email is already registered as a recovery email for another account" });
      }
    }

    // Verify the user exists in Firebase Auth
    try {
      await auth.getUserByEmail(email);
    } catch (error) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP keyed by recovery email
    const otpDocRef = firestore.collection("otps").doc(recoveryEmail.toLowerCase());
    await otpDocRef.set({
      otp,
      expiresAt,
      createdAt: new Date(),
    });

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
          <div style="text-align: center;">
            <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
          </div>
        </div>
        <div style="padding: 0 20px;">
          <p>Hello,</p>
          <p>Your recovery email verification code is: <strong style="font-size: 24px;">${otp}</strong></p>
          <p>This code will expire in 10 minutes.</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: senderEmail,
      to: recoveryEmail,
      subject: "Verify your recovery email for Pipeline",
      html: htmlContent,
    });

    return res.status(200).json({ message: "OTP sent to recovery email successfully" });
  } catch (error) {
    console.error("Error sending recovery OTP:", error);
    return res.status(500).json({ error: "Failed to send recovery OTP" });
  }
});

router.post("/verify-recovery-otp", async (req, res) => {
  try {
    const { email, recoveryEmail, otp } = req.body;
    if (!email || !recoveryEmail || !otp) {
      return res.status(400).json({ error: "Email, recovery email, and OTP are required" });
    }

    const otpDocRef = firestore.collection("otps").doc(recoveryEmail.toLowerCase());
    const snapshot = await otpDocRef.get();

    if (!snapshot.exists) {
      return res.status(400).json({ error: "No pending verification found or code is invalid." });
    }

    const data = snapshot.data();
    if (data.otp !== otp) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    if (data.expiresAt.toDate() < new Date()) {
      await otpDocRef.delete();
      return res.status(400).json({ error: "Verification code has expired. Please request a new one." });
    }

    // Valid OTP, delete it
    await otpDocRef.delete();

    // Update user profile with recovery email
    const usersRef = firestore.collection("users_profiles");
    const userSnapshot = await usersRef.where("email", "==", email.toLowerCase()).limit(1).get();

    if (userSnapshot.empty) {
      return res.status(404).json({ error: "User not found" });
    }

    await userSnapshot.docs[0].ref.update({
      recoveryEmail: recoveryEmail.toLowerCase(),
      recoveryEmailVerified: true,
      recoveryEmailVerifiedAt: new Date(),
    });

    return res.status(200).json({
      message: "Recovery email verified successfully",
      recoveryEmail: recoveryEmail.toLowerCase(),
    });
  } catch (error) {
    console.error("Error verifying recovery OTP:", error);
    return res.status(500).json({ error: "Failed to verify recovery OTP" });
  }
});

// ----- RECOVERY EMAIL LINK ROUTES (legacy) -----
router.post("/send-recovery-email-verification", async (req, res) => {
  try {
    const { email, recoveryEmail } = req.body;

    if (!email || !recoveryEmail) {
      return res.status(400).json({ error: "Email and recovery email are required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recoveryEmail)) {
      return res.status(400).json({ error: "Invalid recovery email format" });
    }

    if (email.toLowerCase() === recoveryEmail.toLowerCase()) {
      return res.status(400).json({ error: "Recovery email must be different from your primary email" });
    }

    // Check if this recovery email is already verified by another user
    const usersRef = firestore.collection("users_profiles");
    const existingSnapshot = await usersRef
      .where("recoveryEmail", "==", recoveryEmail.toLowerCase())
      .where("recoveryEmailVerified", "==", true)
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      const existingUser = existingSnapshot.docs[0].data();
      // Only block if it's a different user
      if (existingUser.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({ error: "This email is already registered as a recovery email for another account" });
      }
    }

    // Verify the user exists in Firebase Auth
    try {
      await auth.getUserByEmail(email);
    } catch (error) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate JWT with 1 hour expiry
    const token = jwt.sign({ email, recoveryEmail }, jwtSecret, {
      expiresIn: "1h",
    });

    const verifyLink = `${process.env.FRONTEND_URL}/verify-recovery-email?token=${token}`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
          <div style="text-align: center;">
            <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
          </div>
        </div>
        <div style="padding: 0 20px;">
          <p>Hello,</p>
          <p>You requested to add this email as a recovery email for your Pipeline account (<strong>${email}</strong>).</p>
          <p>Please click the button below to verify this recovery email. This link will expire in 1 hour.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold;">Verify Recovery Email</a>
          </div>
          <p style="font-size: 14px; color: #666;">If you didn't request this, you can safely ignore this email.</p>
          <p style="font-size: 12px; color: #666; margin-top: 30px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="font-size: 12px; color: #2563eb; word-break: break-all;">${verifyLink}</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: senderEmail,
      to: recoveryEmail,
      subject: "Verify your recovery email for Pipeline",
      html: htmlContent,
    });

    return res.status(200).json({ message: "Verification email sent to your recovery email address." });
  } catch (error) {
    console.error("Error in send-recovery-email-verification:", error);
    return res.status(500).json({ error: "Failed to send verification email" });
  }
});

router.post("/verify-recovery-email", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Verification link has expired. Please request a new one." });
      }
      return res.status(401).json({ error: "Invalid verification link." });
    }

    if (!decoded || !decoded.email || !decoded.recoveryEmail) {
      return res.status(401).json({ error: "Invalid verification link." });
    }

    // Find user document in Firestore by email
    const usersRef = firestore.collection("users_profiles");
    const snapshot = await usersRef.where("email", "==", decoded.email).limit(1).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "User not found" });
    }

    // Update the user document with the recovery email and verification status
    const userDoc = snapshot.docs[0];
    await userDoc.ref.update({
      recoveryEmail: decoded.recoveryEmail.toLowerCase(),
      recoveryEmailVerified: true,
      recoveryEmailVerifiedAt: new Date()
    });

    return res.status(200).json({
      message: "Recovery email verified successfully",
      recoveryEmail: decoded.recoveryEmail,
    });
  } catch (error) {
    console.error("Error in verify-recovery-email:", error);
    return res.status(500).json({ error: "Failed to verify recovery email" });
  }
});

router.post("/check-recovery-email", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Check if user exists in Firebase Auth
    try {
      await auth.getUserByEmail(email);
    } catch (error) {
      // Don't reveal whether the email exists
      return res.status(200).json({ hasRecoveryEmail: false });
    }

    // Check Firestore for recovery email
    const usersRef = firestore.collection("users_profiles");
    const snapshot = await usersRef.where("email", "==", email).limit(1).get();

    if (snapshot.empty) {
      return res.status(200).json({ hasRecoveryEmail: false });
    }

    const userData = snapshot.docs[0].data();
    return res.status(200).json({
      hasRecoveryEmail: !!userData.recoveryEmail,
    });
  } catch (error) {
    console.error("Error checking recovery email:", error);
    return res.status(200).json({ hasRecoveryEmail: false });
  }
});

router.post("/check-email-availability", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const usersRef = firestore.collection("users_profiles");
    const snapshot = await usersRef
      .where("recoveryEmail", "==", email.toLowerCase())
      .where("recoveryEmailVerified", "==", true)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return res.status(200).json({
        available: false,
        reason: "This email is already registered as a recovery email for another account."
      });
    }

    return res.status(200).json({ available: true });
  } catch (error) {
    console.error("Error checking email availability:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ----- ACCOUNT RECOVERY ROUTES -----
router.post("/initiate-account-recovery", async (req, res) => {
  try {
    const { recoveryEmail } = req.body;

    if (!recoveryEmail) {
      return res.status(400).json({ error: "Recovery email is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recoveryEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Find the account with this verified recovery email
    const usersRef = firestore.collection("users_profiles");
    const snapshot = await usersRef
      .where("recoveryEmail", "==", recoveryEmail.toLowerCase())
      .where("recoveryEmailVerified", "==", true)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Don't reveal if the recovery email exists or not for security
      return res.status(200).json({ message: "If an account exists with this recovery email, you will receive a verification link." });
    }

    const userData = snapshot.docs[0].data();
    const userDocId = snapshot.docs[0].id;

    // Generate JWT with 1 hour expiry - includes user doc ID for recovery
    const token = jwt.sign(
      {
        recoveryEmail: recoveryEmail.toLowerCase(),
        userDocId,
        primaryEmail: userData.email,
        type: "account-recovery"
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    const recoveryLink = `${process.env.FRONTEND_URL}/account-recovery?token=${token}`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
          <div style="text-align: center;">
            <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
          </div>
        </div>
        <div style="padding: 0 20px;">
          <p>Hello,</p>
          <p>You requested to recover your Pipeline account associated with <strong>${userData.email}</strong>.</p>
          <p>Click the button below to verify your identity and update your account email. This link will expire in 1 hour.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${recoveryLink}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold;">Recover My Account</a>
          </div>
          <p style="font-size: 14px; color: #666;">If you didn't request this, you can safely ignore this email. Your account is secure.</p>
          <p style="font-size: 12px; color: #666; margin-top: 30px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="font-size: 12px; color: #2563eb; word-break: break-all;">${recoveryLink}</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: senderEmail,
      to: recoveryEmail,
      subject: "Recover your Pipeline account",
      html: htmlContent,
    });

    return res.status(200).json({ message: "If an account exists with this recovery email, you will receive a verification link." });
  } catch (error) {
    console.error("Error in initiate-account-recovery:", error);
    return res.status(500).json({ error: "Failed to initiate account recovery" });
  }
});

router.post("/verify-account-recovery-token", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Recovery link has expired. Please request a new one." });
      }
      return res.status(401).json({ error: "Invalid recovery link." });
    }

    if (!decoded || decoded.type !== "account-recovery" || !decoded.userDocId) {
      return res.status(401).json({ error: "Invalid recovery link." });
    }

    // Return the primary email so the user knows which account they're recovering
    return res.status(200).json({
      valid: true,
      primaryEmail: decoded.primaryEmail,
      recoveryEmail: decoded.recoveryEmail
    });
  } catch (error) {
    console.error("Error in verify-account-recovery-token:", error);
    return res.status(500).json({ error: "Failed to verify recovery token" });
  }
});

router.post("/complete-account-recovery", async (req, res) => {
  try {
    const { token, newEmail } = req.body;

    if (!token || !newEmail) {
      return res.status(400).json({ error: "Token and new email are required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Recovery link has expired. Please request a new one." });
      }
      return res.status(401).json({ error: "Invalid recovery link." });
    }

    if (!decoded || decoded.type !== "account-recovery" || !decoded.userDocId) {
      return res.status(401).json({ error: "Invalid recovery link." });
    }

    // Check if new email is already in use by another account
    try {
      const existingUser = await auth.getUserByEmail(newEmail);
      // If the email belongs to the same user (recovering to their recovery email), that's OK
      const userDoc = await firestore.collection("users_profiles").doc(decoded.userDocId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        // Get Firebase Auth UID for this user
        const oldFirebaseUser = await auth.getUserByEmail(userData.email);
        if (existingUser.uid !== oldFirebaseUser.uid) {
          return res.status(400).json({ error: "This email is already in use by another account" });
        }
      }
    } catch (error) {
      // Email not in use, which is good
    }

    // Get the user document
    const userDoc = await firestore.collection("users_profiles").doc(decoded.userDocId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    // Get Firebase Auth user by old email
    let firebaseUser;
    try {
      firebaseUser = await auth.getUserByEmail(userData.email);
    } catch (error) {
      return res.status(404).json({ error: "User authentication record not found" });
    }

    // Update Firebase Auth email
    await auth.updateUser(firebaseUser.uid, { email: newEmail.toLowerCase() });

    // Update Firestore user profile
    await userDoc.ref.update({
      email: newEmail.toLowerCase(),
      // If the new email is the recovery email, we need to clear it or set a new one later
      // For now, we'll keep the recovery email as is
    });

    // Update Stripe customer email if they have one
    if (userData.stripe_customer_id) {
      try {
        await stripe.customers.update(userData.stripe_customer_id, {
          email: newEmail.toLowerCase()
        });
      } catch (stripeError) {
        console.error("Failed to update Stripe customer email:", stripeError);
        // Don't fail the whole operation for Stripe error
      }
    }

    return res.status(200).json({
      message: "Account recovered successfully. You can now log in with your new email.",
      newEmail: newEmail.toLowerCase()
    });
  } catch (error) {
    console.error("Error in complete-account-recovery:", error);
    return res.status(500).json({ error: "Failed to complete account recovery" });
  }
});
export default router;
