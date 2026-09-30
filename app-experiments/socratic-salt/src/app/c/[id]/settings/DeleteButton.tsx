"use client";

export function DeleteButton({ action }: { action: () => Promise<void> }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm("Delete this challenge and every conversation with it?")) e.preventDefault();
      }}
    >
      <button className="h-12 rounded-full border border-red-200 px-6 text-base font-semibold text-red-600 transition hover:bg-red-50">
        Delete challenge
      </button>
    </form>
  );
}
