import { redirect } from "next/navigation";

/**
 * Routes the product root to the operational dashboard.
 */
export default function HomePage() {
  redirect("/dashboard");
}
