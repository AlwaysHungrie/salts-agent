import { Plus } from "lucide-react";

/** What a signed-out visitor sees: the way in, and the terms that come with it. */
export function FrontDoor({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="mt-4 space-y-2 w-full">
      <button
        onClick={onConnect}
        className="w-full min-h-17 bg-canvas-soft hover:bg-canvas-soft/60 group flex cursor-pointer items-center gap-3 rounded-2xl px-5 py-4 transition"
      >
        <Plus size={18} strokeWidth={2} />
        Connect your Account
      </button>
      <p className="text-faint mt-2 ml-2 text-xs leading-[1.33]">
        By signing up and using this platform you agree to our{" "}
        <a href="/tos" className="text-primary hover:underline">
          terms of service
        </a>{" "}
        and{" "}
        <a href="/privacy" className="text-primary hover:underline">
          privacy policy
        </a>
        .
        <br />
      </p>
    </div>
  );
}
