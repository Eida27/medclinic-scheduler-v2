import Link from "next/link";
import { ForgotPasswordForm } from "@/components/account/ForgotPasswordForm";
import { BrandMark } from "@/components/branding/BrandMark";
import { Card } from "@/components/ui/Card";

export default function ForgotPasswordPage() {
  return <main className="grid min-h-screen place-items-center bg-canvas p-4"><Card className="w-full max-w-md p-7 sm:p-9"><BrandMark priority /><h1 className="mt-7 text-2xl font-bold text-ink">Forgot Password</h1><p className="mb-6 mt-2 text-sm leading-6 text-muted">Enter your verified staff email. Pending onboarding accounts must ask an Administrator for a temporary-password reset.</p><ForgotPasswordForm /><Link href="/login" className="mt-5 block text-center text-sm font-semibold text-cpu-navy hover:underline">Back to Login</Link></Card></main>;
}
