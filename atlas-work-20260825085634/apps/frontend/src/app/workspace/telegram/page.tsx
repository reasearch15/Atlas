import { TelegramWorkspace } from "@/features/telegram/telegram-workspace";

export default async function WorkspaceTelegramPage({
  searchParams
}: {
  readonly searchParams: Promise<{ accountId?: string; developerAppId?: string }>;
}) {
  const params = await searchParams;
  return <TelegramWorkspace initialAccountId={params.accountId ?? null} initialDeveloperAppId={params.developerAppId ?? null} />;
}
