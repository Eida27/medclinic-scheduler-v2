import { StaffEmailVerificationConfirm } from "@/components/account/StaffEmailVerificationConfirm";
import { BrandMark } from "@/components/branding/BrandMark";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";

export default async function StaffEmailVerificationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <main className="grid min-h-screen place-items-center bg-canvas p-4"><Card className="w-full max-w-md p-7 sm:p-9"><BrandMark priority /><h1 className="mt-7 text-2xl font-bold text-ink">Staff email verification</h1><div className="mt-6">{token ? <StaffEmailVerificationConfirm token={token} /> : <Alert tone="danger">This staff email verification link is invalid.</Alert>}</div></Card></main>;
}
