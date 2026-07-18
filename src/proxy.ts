import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session";
import { STUDENT_SESSION_COOKIE, verifyStudentSessionToken } from "@/server/auth/student-session";

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/student")) {
    if (request.nextUrl.pathname === "/student/login") return NextResponse.next();
    const studentToken = request.cookies.get(STUDENT_SESSION_COOKIE)?.value;
    if (!studentToken) return NextResponse.redirect(new URL("/student/login", request.url));
    try {
      await verifyStudentSessionToken(studentToken);
      return NextResponse.next();
    } catch {
      const response = NextResponse.redirect(new URL("/student/login", request.url));
      response.cookies.delete(STUDENT_SESSION_COOKIE);
      return response;
    }
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.redirect(new URL("/login", request.url));

  try {
    await verifySessionToken(token);
    return NextResponse.next();
  } catch {
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/students/:path*",
    "/coordinator-schedules/:path*",
    "/appointments/:path*",
    "/compliance/:path*",
    "/results/:path*",
    "/settings/:path*",
    "/student/:path*",
  ],
};
