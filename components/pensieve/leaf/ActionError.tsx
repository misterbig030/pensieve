import Link from "next/link";

/** An action's failure, with a way to Settings when the cause is the learner's API key. */
export function ActionError({ message, settingsLink = false }: { message: string; settingsLink?: boolean }) {
  return (
    <p className="text-sm text-red-600">
      {message}
      {settingsLink && (
        <>
          {" "}
          <Link href="/settings" className="underline">
            Open Settings
          </Link>
        </>
      )}
    </p>
  );
}
