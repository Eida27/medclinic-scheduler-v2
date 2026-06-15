import Link from "next/link";
import { BrandMark } from "@/components/branding/BrandMark";
import { StudentLookupForm } from "@/components/lookup/StudentLookupForm";

export default function StudentLookupPage() {
  return (
    <main className="min-h-screen bg-canvas">
      <header className="border-b border-white/10 bg-cpu-navy px-4 py-5 text-white sm:px-8">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <BrandMark inverse priority />
          <Link href="/" className="rounded-xl border border-white/20 px-3 py-2 text-sm font-bold transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold">Home</Link>
        </div>
      </header>
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-14">
        <div className="mb-8 max-w-2xl">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-cpu-gold-dark">Student services</p>
          <h1 className="text-3xl font-black tracking-tight text-ink sm:text-4xl">Find your clinic schedule</h1>
          <p className="mt-3 leading-7 text-muted">Enter your student number to view published physical examination and laboratory appointments.</p>
        </div>
        <StudentLookupForm />
      </div>
    </main>
  );
}
