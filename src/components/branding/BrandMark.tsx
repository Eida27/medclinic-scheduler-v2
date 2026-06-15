import Image from "next/image";
import { cn } from "@/lib/cn";

type BrandMarkProps = {
  compact?: boolean;
  inverse?: boolean;
  priority?: boolean;
  className?: string;
};

export function BrandMark({ compact = false, inverse = false, priority = false, className }: BrandMarkProps) {
  return (
    <div className={cn("flex items-center gap-3", inverse ? "text-white" : "text-ink", className)}>
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white p-1 shadow-brand ring-1 ring-cpu-gold/35">
        <Image
          src="/branding/cpu-seal.png"
          alt="Central Philippine University seal"
          width={44}
          height={44}
          priority={priority}
          className="size-full object-contain"
        />
      </span>
      {compact ? null : (
        <span className="min-w-0">
          <span className="block font-bold tracking-tight">MedClinic Scheduler</span>
          <span className={cn("block text-xs", inverse ? "text-white/65" : "text-muted")}>CPU Health Services</span>
        </span>
      )}
    </div>
  );
}
