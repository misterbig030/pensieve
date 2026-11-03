import { Progress } from "@/components/ui/progress";
import { formatReset } from "@/lib/credits";
import type { CreditStatus } from "@/lib/db/creditStatus";
import { cn } from "@/lib/utils";

/** The month's free credits (docs/mockups/free-credits.html, section 2). The top bar's pill and the alert link here. */
export function CreditsCard({ left, allowance, resetsAt, keyCoversAll, paused }: CreditStatus) {
  const reset = formatReset(resetsAt);
  return (
    <div id="credits" className="scroll-mt-6 rounded-xl bg-card p-5 text-sm text-card-foreground ring-1 ring-foreground/10">
      <h3 className="font-heading text-[18px]">Credits</h3>
      <div className="mt-3.5 flex items-baseline gap-1.5">
        <b className={cn("font-heading text-[30px] leading-none font-normal", left === 0 && "text-red-600")}>{left}</b>
        <span className="text-[13px] text-muted-foreground">of {allowance} credits left this month</span>
        <span className="ml-auto text-[13px] text-muted-foreground">Resets {reset}</span>
      </div>
      <Progress value={(left / allowance) * 100} aria-label="Credits left this month" className="mt-2.5" />
      {keyCoversAll ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          Your API key pays for your usage, so these credits are only used if a call runs on Pensieve&apos;s key.
        </p>
      ) : (
        <>
          {paused && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              New plans and plan chat are paused until {reset}. Your plans, lessons and filling in weeks keep working. Add an API key below to keep going
              now.
            </p>
          )}
          <p className="mt-3.5 flex items-center gap-2 border-t border-foreground/10 pt-3 text-[13px] text-muted-foreground">
            Paid plans with more credits are coming.
            <span className="rounded-full bg-neutral-200 px-1.5 py-px text-[10.5px] font-semibold text-neutral-700">soon</span>
          </p>
        </>
      )}
    </div>
  );
}
