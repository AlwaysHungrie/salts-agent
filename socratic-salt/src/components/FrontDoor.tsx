"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { AuthModal } from "./auth/AuthModal";

/** Signed out: the one way in, as on frontend/'s home page. */
export function FrontDoor({ redirectUrl = "/" }: { redirectUrl?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 w-full space-y-2">
      <button
        onClick={() => setOpen(true)}
        className="bg-canvas-soft hover:bg-canvas-soft/60 flex min-h-17 w-full cursor-pointer items-center gap-3 rounded-2xl px-5 py-4 transition"
      >
        <Plus size={18} strokeWidth={2} />
        Sign in to take on a challenge
      </button>
      {open && <AuthModal mode="sign-in" redirectUrl={redirectUrl} onClose={() => setOpen(false)} />}
    </div>
  );
}
