import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios'
import { Capacitor } from '@capacitor/core'
import { Network } from '@capacitor/network'
import { Preferences } from '@capacitor/preferences'
import baseURLApi from '@/api/baseURLApi'
import { useAuthStore } from '@/store/auth'
import i18n from '@/i18n'
import { notifyServerMaintenanceToast, notifySessionExpiredToast } from '@/services/toastBridge'

const api = axios.create({
  baseURL: baseURLApi.url,
  timeout: 30000,
})

export const API_BASE_URL = baseURLApi.url
export const SLOW_API_TIMEOUT = 30000

const t = (key: string) => String(i18n.global.t(key))

function requestAuthToken(config: AxiosError['config']): string {
  if (!config) return ''
  const tagged = (config as { vipAuthToken?: string }).vipAuthToken
  if (tagged?.trim()) return tagged.trim()
  const headers = config.headers as { get?: (k: string) => string; Authorization?: string; authorization?: string } | undefined
  const raw = String(
    headers?.get?.('Authorization') || headers?.Authorization || headers?.authorization || '',
  )
  return raw.replace(/^Bearer\s+/i, '').trim()
}

/** 401 của request cũ không được xóa token vừa login. */
function isStaleUnauthorized(error: AxiosError, currentToken: string): boolean {
  const used = requestAuthToken(error.config)
  const current = currentToken.trim()
  return Boolean(used && current && used !== current)
}

function isLoginApiRequest(error: AxiosError) {
  const url = String(error.config?.url || '').toLowerCase()
  return (
    url.includes('login') ||
    url.includes('driverlogin') ||
    url.includes('getvehicles')
  )
}

/** Chỉ coi offline khi thiết bị thật sự mất mạng — không ép offline vì API fail */
async function isDeviceOffline(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const status = await Network.getStatus()
      return !status.connected
    }
  } catch {
    /* fallback web */
  }
  return typeof navigator !== 'undefined' ? !navigator.onLine : false
}

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const authStore = useAuthStore()
  let token = authStore.token?.trim() || ''

  if (!token) {
    const { value } = await Preferences.get({ key: 'vip_token' })
    token = value?.trim() || ''
    if (token && !authStore.token) {
      authStore.token = token
    }
  }

  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`
    ;(config as InternalAxiosRequestConfig & { vipAuthToken?: string }).vipAuthToken = token
  }

  return config
})

api.interceptors.response.use(
  (response) => {
    const authStore = useAuthStore()
    if (!authStore.isOnline) {
      authStore.setNetworkStatus(true)
    }
    return response
  },
  async (error: AxiosError) => {
    const authStore = useAuthStore()
    const deviceOffline = await isDeviceOffline()

    // Không có response: mất mạng / timeout / server down
    if (!error.response) {
      // Chỉ chuyển offline UI khi thiết bị không có mạng
      if (deviceOffline) {
        authStore.setNetworkStatus(false)
      }
      if (!isLoginApiRequest(error)) {
        notifyServerMaintenanceToast(t('common.serverMaintenance'), t('common.warning'))
      }
      return Promise.reject(error)
    }

    const status = error.response.status

    // Token hết hạn / không hợp lệ — clearSession (token + cache Select + step 1), giữ offline queue
    if (status === 401) {
      if (!isLoginApiRequest(error) && !isStaleUnauthorized(error, authStore.token || '')) {
        notifySessionExpiredToast(t('common.sessionExpired'), t('common.warning'))
        await authStore.clearSession()
      }
      return Promise.reject(error)
    }

    // Server 5xx: toast cảnh báo; chỉ offline UI nếu thiết bị thật sự mất mạng
    if (status >= 500) {
      if (deviceOffline) {
        authStore.setNetworkStatus(false)
      }
      if (!isLoginApiRequest(error)) {
        notifyServerMaintenanceToast(t('common.serverMaintenance'), t('common.warning'))
      }
      return Promise.reject(error)
    }

    return Promise.reject(error)
  },
)

export type RequestConfig = AxiosRequestConfig & {
  timeout?: number
}

/** Wrapper gọi API — signature giống MixGlueTablet (get: url, params, config). */
const request = {
  get: <T = unknown>(url: string, params?: unknown, config?: RequestConfig) =>
    api.get<T>(url, { params, ...config }),
  post: <T = unknown>(url: string, data?: unknown, config?: RequestConfig) =>
    api.post<T>(url, data, config),
  put: <T = unknown>(url: string, data?: unknown, config?: RequestConfig) =>
    api.put<T>(url, data, config),
  patch: <T = unknown>(url: string, data?: unknown, config?: RequestConfig) =>
    api.patch<T>(url, data, config),
  delete: <T = unknown>(url: string, config?: RequestConfig) => api.delete<T>(url, config),
}

export { api }
export default request
