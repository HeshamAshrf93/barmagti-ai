// التحقق من Firebase ID Token جوه Cloudflare Worker (من غير firebase-admin)
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

/**
 * بيرجّع بيانات المستخدم لو التوكن سليم، أو null لو مش سليم.
 * verifier اختياري عشان الاختبارات.
 */
export async function verifyFirebaseToken(token, projectId, verifier) {
  if (!token) return null;
  try {
    if (verifier) return await verifier(token);
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
    });
    if (!payload.sub) return null;
    return {
      uid: payload.sub,
      email: payload.email || null,
      emailVerified: payload.email_verified === true,
    };
  } catch {
    return null;
  }
}

export function isTeacher(user, teacherEmailsCsv) {
  if (!user?.email) return false;
  const list = (teacherEmailsCsv || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(user.email.toLowerCase());
}
