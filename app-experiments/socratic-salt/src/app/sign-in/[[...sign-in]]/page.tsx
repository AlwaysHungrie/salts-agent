import { AuthCard } from "@/components/auth/AuthCard";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-16">
      <AuthCard mode="sign-in" />
    </div>
  );
}
