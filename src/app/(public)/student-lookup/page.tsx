import Link from "next/link";
import { StudentLookupForm } from "@/components/lookup/StudentLookupForm";

export default function StudentLookupPage() { return <main className="min-h-screen bg-slate-50 p-4 sm:p-8"><div className="mx-auto max-w-2xl"><Link href="/" className="text-sm font-bold text-teal-700">← MedClinic home</Link><div className="my-8"><h1 className="text-3xl font-black text-slate-950">Find your clinic schedule</h1><p className="mt-2 text-slate-600">Enter your student number to view published physical examination and laboratory appointments.</p></div><StudentLookupForm /></div></main>; }
