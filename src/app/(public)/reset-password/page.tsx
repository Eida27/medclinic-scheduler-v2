import Link from "next/link";
import { ResetPasswordForm } from "@/components/account/ResetPasswordForm";
import { BrandMark } from "@/components/branding/BrandMark";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <main className="grid min-h-screen place-items-center bg-canvas p-4"><Card className="w-full max-w-md p-7 sm:p-9"><BrandMark priority /><h1 className="mt-7 text-2xl font-bold text-ink">Reset Password</h1><p className="mb-6 mt-2 text-sm leading-6 text-muted">Choose a new 8–100 character password that differs from the current one.</p>{token ? <ResetPasswordForm token={token} /> : <Alert tone="danger">This password reset link is invalid.</Alert>}<Link href="/login" className="mt-5 block text-center text-sm font-semibold text-cpu-navy hover:underline">Back to Login</Link></Card></main>;
}
