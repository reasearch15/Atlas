"use client";

import type {
  ApiErrorBody,
  AdminDashboardResponse,
  AdminCoadminDetail,
  AdminCoadminListItem,
  AdminLoginResponse,
  AdminTrustedDeviceDto,
  AuthResponse,
  CoadminDashboardResponse,
  StaffDetail,
  StaffListItem,
  TenantLoginResponse,
  DashboardStats,
  MeResponse,
  AuditLogDto,
  CrmAssigneeDto,
  CrmConversationPanelDto,
  CrmConversationStatus,
  CrmInboxCountsDto,
  CrmNoteDto,
  CrmTagDto,
  DeveloperAppDto,
  TelegramAccountDto,
  TelegramAccountPermanentDeleteResponse,
  TelegramChatDto,
  TelegramChatIdentityBackfillResult,
  TelegramMediaPresignInput,
  TelegramMessageDto,
  TelegramSendMediaInput,
  InternalMessageDto,
  InternalMessageThreadDto
} from "@atlas/shared";
import { useAuthStore } from "@/stores/auth-store";
import { clearRoleAuthBootstrap, markRoleAuthenticated } from "@/lib/auth-bootstrap";
import { handleFailedSessionRefresh, refreshPathFor, refreshSessionForPath } from "@/lib/auth-refresh";
import { publicApiUrl } from "@/lib/public-api-url";
import { clearRoleSensitiveClientCaches } from "@/lib/sensitive-cache";

const baseUrl = publicApiUrl;

/**
 * Applies a successful login/refresh response to client auth state.
 */
function applyAuthenticatedSession(accessToken: string, user: AuthResponse["user"]): void {
  clearRoleAuthBootstrap();
  clearRoleSensitiveClientCaches();
  useAuthStore.getState().setSession(accessToken, user);
  markRoleAuthenticated(user.role);
}

/**
 * Performs an authenticated JSON request against the Atlas API.
 * On 401 ACCESS_TOKEN_EXPIRED (or UNAUTHORIZED for refreshable routes), refreshes once
 * via a shared lock and retries the original request exactly once with the same body.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}, retryOnUnauthorized = true): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const hasJsonBody = typeof init.body === "string" && init.body.length > 0;
  const headers = {
    ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...init.headers
  };
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers
  });

  if (response.status === 401 && retryOnUnauthorized) {
    const errorBody = (await response.clone().json().catch(() => null)) as ApiErrorBody | null;
    const code = errorBody?.error?.code;
    const canRefresh =
      code === "ACCESS_TOKEN_EXPIRED" || (code === "UNAUTHORIZED" && refreshPathFor(path) !== null) || (!code && refreshPathFor(path) !== null);

    if (canRefresh) {
      const refreshed = await refreshSessionForPath(path);
      if (refreshed) {
        return apiRequest<T>(path, init, false);
      }
      if (code === "ACCESS_TOKEN_EXPIRED" || refreshPathFor(path) !== null) {
        handleFailedSessionRefresh();
        throw new Error("ACCESS_TOKEN_EXPIRED: Your session expired. Please sign in again.");
      }
    }
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    const code = body?.error.code;
    const message = body?.error.message ?? "Request failed";
    throw new Error(code ? `${code}: ${message}` : message);
  }

  return (await response.json()) as T;
}

/**
 * Authenticates the user and stores their access token in memory-backed app state.
 */
export async function login(payload: { email: string; password: string; workspaceSlug?: string }): Promise<AuthResponse> {
  const response = await apiRequest<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  applyAuthenticatedSession(response.accessToken, response.user);
  return response;
}

/**
 * Starts the Platform Admin login flow.
 */
export async function adminLogin(payload: { email: string; password: string }): Promise<AdminLoginResponse> {
  const response = await apiRequest<AdminLoginResponse>("/api/admin-auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!("requiresVerification" in response)) {
    applyAuthenticatedSession(response.accessToken, response.user);
  }
  return response;
}

/**
 * Completes Platform Admin new-device verification.
 */
export async function adminVerifyDevice(payload: { challengeId: string; code: string }): Promise<AuthResponse> {
  const response = await apiRequest<AuthResponse>("/api/admin-auth/verify-device", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  applyAuthenticatedSession(response.accessToken, response.user);
  return response;
}

/**
 * Requests a replacement Platform Admin verification code.
 */
export async function adminResendCode(challengeId: string): Promise<{ maskedEmail: string; expiresAt: string; resendAvailableAt: string }> {
  return apiRequest("/api/admin-auth/resend-code", { method: "POST", body: JSON.stringify({ challengeId }) });
}

/**
 * Starts the Coadmin login flow.
 */
export async function coadminLogin(payload: { username: string; password: string }): Promise<TenantLoginResponse> {
  const response = await apiRequest<TenantLoginResponse>("/api/coadmin-auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!("requiresPasswordChange" in response)) {
    applyAuthenticatedSession(response.accessToken, response.user);
  }
  return response;
}

/**
 * Completes Coadmin first-login password change.
 */
export async function coadminChangePassword(payload: { changeToken: string; password: string; confirmPassword: string }): Promise<AuthResponse> {
  const response = await apiRequest<AuthResponse>("/api/coadmin-auth/change-password", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  applyAuthenticatedSession(response.accessToken, response.user);
  return response;
}

/**
 * Starts the Staff login flow.
 */
export async function staffLogin(payload: { username: string; password: string }): Promise<TenantLoginResponse> {
  const response = await apiRequest<TenantLoginResponse>("/api/staff-auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!("requiresPasswordChange" in response)) {
    applyAuthenticatedSession(response.accessToken, response.user);
  }
  return response;
}

/**
 * Starts the tenant login flow without exposing role selection in the UI.
 */
export async function tenantLogin(payload: { username: string; password: string }): Promise<{ role: "coadmin" | "staff"; response: TenantLoginResponse }> {
  try {
    return { role: "coadmin", response: await coadminLogin(payload) };
  } catch (coadminError) {
    try {
      return { role: "staff", response: await staffLogin(payload) };
    } catch (staffError) {
      throw staffError instanceof Error ? staffError : coadminError;
    }
  }
}

/**
 * Completes Staff first-login password change.
 */
export async function staffChangePassword(payload: { changeToken: string; password: string; confirmPassword: string }): Promise<AuthResponse> {
  const response = await apiRequest<AuthResponse>("/api/staff-auth/change-password", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  applyAuthenticatedSession(response.accessToken, response.user);
  return response;
}

/**
 * Clears the active API session on the server and client.
 */
export async function logout(): Promise<void> {
  await apiRequest<{ success: true }>("/api/auth/logout", { method: "POST" }).catch(() => ({ success: true }));
  clearRoleAuthBootstrap();
  useAuthStore.getState().clearSession();
}

/**
 * Clears the active Platform Admin session on the server and client.
 */
export async function adminLogout(): Promise<void> {
  await apiRequest<{ success: true }>("/api/admin-auth/logout", { method: "POST" }).catch(() => ({ success: true }));
  clearRoleAuthBootstrap();
  useAuthStore.getState().clearSession();
}

/**
 * Clears the active Coadmin session on the server and client.
 */
export async function coadminLogout(): Promise<void> {
  await apiRequest<{ success: true }>("/api/coadmin-auth/logout", { method: "POST" }).catch(() => ({ success: true }));
  clearRoleAuthBootstrap();
  useAuthStore.getState().clearSession();
}

/**
 * Clears the active Staff session on the server and client.
 */
export async function staffLogout(): Promise<void> {
  await apiRequest<{ success: true }>("/api/staff-auth/logout", { method: "POST" }).catch(() => ({ success: true }));
  clearRoleAuthBootstrap();
  useAuthStore.getState().clearSession();
}

export const api = {
  me: () => apiRequest<MeResponse>("/api/auth/me"),
  adminMe: () => apiRequest<AuthResponse["user"]>("/api/admin-auth/me"),
  adminDashboard: () => apiRequest<AdminDashboardResponse>("/api/admin/dashboard"),
  adminCoadmins: (params?: { search?: string; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.status) query.set("status", params.status);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return apiRequest<AdminCoadminListItem[]>(`/api/admin/coadmins${suffix}`);
  },
  createAdminCoadmin: (payload: {
    username: string;
    temporaryPassword: string;
    confirmTemporaryPassword: string;
  }) => apiRequest<AdminCoadminDetail & { temporaryPassword: string }>("/api/admin/coadmins", { method: "POST", body: JSON.stringify(payload) }),
  adminCoadmin: (id: string) => apiRequest<AdminCoadminDetail>(`/api/admin/coadmins/${id}`),
  resetCoadminPassword: (id: string, temporaryPassword: string) =>
    apiRequest<AdminCoadminDetail & { temporaryPassword: string }>(`/api/admin/coadmins/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ temporaryPassword })
    }),
  suspendCoadmin: (id: string) => apiRequest<AdminCoadminDetail>(`/api/admin/coadmins/${id}/suspend`, { method: "POST" }),
  reactivateCoadmin: (id: string) => apiRequest<AdminCoadminDetail>(`/api/admin/coadmins/${id}/reactivate`, { method: "POST" }),
  archiveCoadmin: (id: string) => apiRequest<AdminCoadminDetail>(`/api/admin/coadmins/${id}/archive`, { method: "POST" }),
  adminDevices: () => apiRequest<AdminTrustedDeviceDto[]>("/api/admin-auth/devices"),
  revokeAdminDevice: (deviceId: string) => apiRequest<{ success: true }>(`/api/admin-auth/devices/${deviceId}`, { method: "DELETE" }),
  revokeAllAdminDevices: () => apiRequest<{ success: true }>("/api/admin-auth/devices", { method: "DELETE" }),
  coadminMe: () => apiRequest<AuthResponse["user"]>("/api/coadmin-auth/me"),
  coadminDashboard: () => apiRequest<CoadminDashboardResponse>("/api/coadmin-auth/dashboard"),
  coadminDevices: () => apiRequest<AdminTrustedDeviceDto[]>("/api/coadmin-auth/devices"),
  revokeCoadminDevice: (deviceId: string) => apiRequest<{ success: true }>(`/api/coadmin-auth/devices/${deviceId}`, { method: "DELETE" }),
  revokeAllCoadminDevices: () => apiRequest<{ success: true }>("/api/coadmin-auth/devices", { method: "DELETE" }),
  staffMe: () => apiRequest<AuthResponse["user"]>("/api/staff-auth/me"),
  staffDevices: () => apiRequest<AdminTrustedDeviceDto[]>("/api/staff-auth/devices"),
  revokeStaffDevice: (deviceId: string) => apiRequest<{ success: true }>(`/api/staff-auth/devices/${deviceId}`, { method: "DELETE" }),
  revokeAllStaffDevices: () => apiRequest<{ success: true }>("/api/staff-auth/devices", { method: "DELETE" }),
  staffMembers: () => apiRequest<StaffListItem[]>("/api/staff"),
  createStaff: (payload: {
    fullName: string;
    username: string;
    temporaryPassword: string;
    confirmTemporaryPassword: string;
    contactEmail?: string;
    status: string;
  }) => apiRequest<{ id: string; temporaryPassword: string }>("/api/staff", { method: "POST", body: JSON.stringify(payload) }),
  staffMember: (id: string) => apiRequest<StaffDetail>(`/api/staff/${id}`),
  resetStaffPassword: (id: string, temporaryPassword: string) =>
    apiRequest<{ id: string; temporaryPassword: string }>(`/api/staff/${id}/reset-password`, { method: "POST", body: JSON.stringify({ temporaryPassword }) }),
  suspendStaff: (id: string) => apiRequest<StaffDetail>(`/api/staff/${id}/suspend`, { method: "POST" }),
  reactivateStaff: (id: string) => apiRequest<StaffDetail>(`/api/staff/${id}/reactivate`, { method: "POST" }),
  archiveStaff: (id: string) => apiRequest<StaffDetail>(`/api/staff/${id}/archive`, { method: "POST" }),
  revokeStaffSession: (staffId: string, sessionId: string) => apiRequest<StaffDetail>(`/api/staff/${staffId}/sessions/${sessionId}`, { method: "DELETE" }),
  revokeAllStaffSessions: (staffId: string) => apiRequest<StaffDetail>(`/api/staff/${staffId}/sessions`, { method: "DELETE" }),
  internalThreads: () => apiRequest<InternalMessageThreadDto[]>("/api/internal-messages/threads"),
  internalThreadMessages: (staffId: string) =>
    apiRequest<InternalMessageDto[]>(`/api/internal-messages/threads/${staffId}`),
  sendInternalMessage: (staffId: string, body: string) =>
    apiRequest<InternalMessageDto>(`/api/internal-messages/threads/${staffId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body })
    }),
  markInternalMessageRead: (messageId: string) =>
    apiRequest<InternalMessageDto>(`/api/internal-messages/messages/${messageId}/read`, { method: "POST" }),
  revokeCoadminSession: (coadminId: string, sessionId: string) => apiRequest<AdminCoadminDetail>(`/api/admin/coadmins/${coadminId}/sessions/${sessionId}`, { method: "DELETE" }),
  revokeAllCoadminSessions: (coadminId: string) => apiRequest<AdminCoadminDetail>(`/api/admin/coadmins/${coadminId}/sessions`, { method: "DELETE" }),
  dashboardStats: () => apiRequest<DashboardStats>("/api/dashboard/stats"),
  auditLogs: () => apiRequest<AuditLogDto[]>("/api/audit-logs"),
  users: () =>
    apiRequest<
      Array<{
        id: string;
        email: string;
        name: string;
        role: string;
        status: string;
        workspaceId: string | null;
        createdAt: string;
      }>
    >("/api/users"),
  workspaces: () =>
    apiRequest<Array<{ id: string; name: string; slug: string; createdAt: string; _count: { users: number; sessions: number } }>>(
      "/api/workspaces"
    ),
  developerApps: () => apiRequest<DeveloperAppDto[]>("/api/developer-apps"),
  createDeveloperApp: (payload: { displayName: string; provider?: "TELEGRAM"; apiId: number; apiHash: string }) =>
    apiRequest<DeveloperAppDto>("/api/developer-apps", {
      method: "POST",
      body: JSON.stringify({ provider: "TELEGRAM", ...payload })
    }),
  updateDeveloperApp: (id: string, payload: { displayName?: string; apiId?: number; apiHash?: string; status?: "ACTIVE" | "DISABLED" }) =>
    apiRequest<DeveloperAppDto>(`/api/developer-apps/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  enableDeveloperApp: (id: string) => apiRequest<DeveloperAppDto>(`/api/developer-apps/${id}/enable`, { method: "POST" }),
  disableDeveloperApp: (id: string) => apiRequest<DeveloperAppDto>(`/api/developer-apps/${id}/disable`, { method: "POST" }),
  deleteDeveloperApp: (id: string) => apiRequest<DeveloperAppDto>(`/api/developer-apps/${id}`, { method: "DELETE" }),
  telegramAccounts: () => apiRequest<TelegramAccountDto[]>("/api/telegram/accounts"),
  createTelegramAccount: (developerAppId: string, displayName: string) =>
    apiRequest<TelegramAccountDto>("/api/telegram/accounts", { method: "POST", body: JSON.stringify({ developerAppId, displayName }) }),
  startTelegramAuth: (accountId: string) => apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/start-auth`, { method: "POST" }),
  submitTelegramPhone: (accountId: string, phoneNumber: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/submit-phone`, { method: "POST", body: JSON.stringify({ phoneNumber }) }),
  submitTelegramCode: (accountId: string, code: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/submit-code`, { method: "POST", body: JSON.stringify({ code }) }),
  submitTelegramPassword: (accountId: string, password: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/submit-password`, { method: "POST", body: JSON.stringify({ password }) }),
  cancelTelegramAuth: (accountId: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/cancel-auth`, { method: "POST" }),
  reauthorizeTelegramAccount: (accountId: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/reauthorize`, { method: "POST" }),
  restartTelegramAuthorization: (accountId: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}/restart-authorization`, { method: "POST" }),
  disconnectTelegramAccount: (accountId: string) =>
    apiRequest<TelegramAccountDto>(`/api/telegram/accounts/${accountId}`, { method: "DELETE" }),
  permanentDeleteTelegramAccount: (accountId: string, confirmation: string) =>
    apiRequest<TelegramAccountPermanentDeleteResponse>(`/api/telegram/accounts/${accountId}/permanent-delete`, {
      method: "POST",
      body: JSON.stringify({ confirmation })
    }),
  telegramChats: (accountId: string) => apiRequest<TelegramChatDto[]>(`/api/telegram/accounts/${accountId}/chats`),
  refreshTelegramChatMetadata: (accountId: string) =>
    apiRequest<{ queued: true; accountId: string }>(`/api/telegram/accounts/${accountId}/chats/refresh-metadata`, { method: "POST" }),
  telegramChatIdentityBackfillResult: (accountId: string) =>
    apiRequest<TelegramChatIdentityBackfillResult | null>(`/api/telegram/accounts/${accountId}/chats/refresh-metadata`),
  telegramMessages: (accountId: string, chatId: string) =>
    apiRequest<TelegramMessageDto[]>(`/api/telegram/accounts/${accountId}/chats/${chatId}/messages`),
  telegramChatMessages: (chatId: string, signal?: AbortSignal) =>
    apiRequest<TelegramMessageDto[]>(`/api/telegram/chats/${chatId}/messages`, signal ? { signal } : {}),
  telegramMarkChatRead: (chatId: string) =>
    apiRequest<{ unreadCount: 0; chatId: string }>(`/api/telegram/chats/${chatId}/read`, { method: "POST" }),
  telegramMediaAccess: (messageId: string, variant: "media" | "thumbnail" = "media") =>
    apiRequest<{ url: string }>(`/api/telegram/messages/${messageId}/media-access?variant=${variant}`),
  sendChatText: (chatId: string, text: string, idempotencyKey: string, replyToTelegramMessageId?: string) =>
    apiRequest<TelegramMessageDto>(`/api/telegram/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        idempotencyKey,
        ...(replyToTelegramMessageId ? { replyToTelegramMessageId } : {})
      })
    }),
  presignChatMedia: (chatId: string, body: TelegramMediaPresignInput) =>
    apiRequest<{ uploadUrl: string; storageKey: string; expiresInSeconds: number }>(
      `/api/telegram/chats/${chatId}/media/presign`,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    ),
  sendChatMedia: (chatId: string, body: TelegramSendMediaInput) =>
    apiRequest<TelegramMessageDto>(`/api/telegram/chats/${chatId}/media`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  sendTelegramText: (accountId: string, chatId: string, text: string, idempotencyKey: string) =>
    apiRequest<TelegramMessageDto>(`/api/telegram/accounts/${accountId}/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, idempotencyKey })
    }),
  crmPanel: (chatId: string) => apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/panel`),
  crmClaim: (chatId: string) => apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/claim`, { method: "POST" }),
  crmRelease: (chatId: string) => apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/release`, { method: "POST" }),
  crmAssign: (chatId: string, assigneeUserId: string | null) =>
    apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/assign`, {
      method: "POST",
      body: JSON.stringify({ assigneeUserId })
    }),
  crmSetStatus: (chatId: string, status: CrmConversationStatus) =>
    apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/status`, {
      method: "POST",
      body: JSON.stringify({ status })
    }),
  crmNotes: (chatId: string) => apiRequest<CrmNoteDto[]>(`/api/crm/chats/${chatId}/notes`),
  crmCreateNote: (chatId: string, body: string) =>
    apiRequest<CrmNoteDto>(`/api/crm/chats/${chatId}/notes`, { method: "POST", body: JSON.stringify({ body }) }),
  crmUpdateNote: (chatId: string, noteId: string, body: string) =>
    apiRequest<CrmNoteDto>(`/api/crm/chats/${chatId}/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ body }) }),
  crmTags: () => apiRequest<CrmTagDto[]>("/api/crm/tags"),
  crmCreateTag: (payload: { name: string; color: string }) =>
    apiRequest<CrmTagDto>("/api/crm/tags", { method: "POST", body: JSON.stringify(payload) }),
  crmUpdateTag: (tagId: string, payload: { name?: string; color?: string; archived?: boolean }) =>
    apiRequest<CrmTagDto>(`/api/crm/tags/${tagId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  crmAddChatTag: (chatId: string, tagId: string) =>
    apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/tags`, { method: "POST", body: JSON.stringify({ tagId }) }),
  crmRemoveChatTag: (chatId: string, tagId: string) =>
    apiRequest<CrmConversationPanelDto>(`/api/crm/chats/${chatId}/tags/${tagId}`, { method: "DELETE" }),
  crmInboxCounts: () => apiRequest<CrmInboxCountsDto>("/api/crm/inbox/counts"),
  crmAssignees: () => apiRequest<CrmAssigneeDto[]>("/api/crm/assignees")
};

export const apiBaseUrl = baseUrl;
