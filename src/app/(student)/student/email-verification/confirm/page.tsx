import { EmailVerificationConfirmation } from "@/components/student/EmailVerificationConfirmation";
import { Card } from "@/components/ui/Card";

type Props = { searchParams: Promise<{ token?: string }> };

export default async function StudentEmailVerificationConfirmPage({ searchParams }: Props) {
  const { token } = await searchParams;
  return (
    <section className="max-w-2xl">
      <h1 className="text-3xl font-bold">Confirm email verification</h1>
      <Card className="mt-6 p-6">
        <EmailVerificationConfirmation token={token ?? null} />
      </Card>
    </section>
  );
}
