import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { serverEnv } from "@/lib/env";

export const STUDENT_SESSION_COOKIE = "medclinic_student_session";
export const STUDENT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export type StudentSession = {
  studentNumber: string;
  sessionType: "STUDENT";
};

function secret(): Uint8Array {
  return new TextEncoder().encode(serverEnv().JWT_SECRET);
}

export async function createStudentSessionToken(session: StudentSession): Promise<string> {
  return new SignJWT({ sessionType: session.sessionType })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.studentNumber)
    .setIssuedAt()
    .setExpirationTime(`${STUDENT_SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret());
}

export async function verifyStudentSessionToken(token: string): Promise<StudentSession> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
  if (!payload.sub || payload.sessionType !== "STUDENT") {
    throw new Error("Invalid student session payload");
  }
  return { studentNumber: payload.sub, sessionType: "STUDENT" };
}
