import employeeCheckInApi, { type EmployeeCheckInResult } from '@/api/employeeCheckIn'
import { useCheckinListStore } from '@/store/checkinList'
import { useAuthStore } from '@/store/auth'
import { showAppToast } from '@/services/toastBridge'
import { speakImportantText } from '@/services/ttsService'
import i18n from '@/i18n'
import { resolveApiError, resolveApiMessage } from '@/utils/apiMessage'

let syncing = false
/** Uuid đang gọi API — chặn sync 1 record vs vòng queue đụng nhau */
const inflightIds = new Set<string>()

export type SyncRecordKind = 'synced' | 'already' | 'retry' | 'failed' | 'skipped' | 'unavailable'

export function isOfflineSyncing() {
  return syncing
}

function payloadStatus(body: { status?: string | null } | null | undefined) {
  return String(body?.status || '').trim()
}

function isAlreadyRecorded(body: { status?: string | null } | null | undefined) {
  const status = payloadStatus(body)
  return status === 'ALREADY_CHECKED_IN' || status === 'CHECK_IN_ALREADY_RECORDED'
}

function isCheckInNotAvailable(body: { status?: string | null } | null | undefined) {
  return payloadStatus(body) === 'CHECK_IN_NOT_AVAILABLE'
}

function errorPayload(err: unknown) {
  return (err as { response?: { data?: { status?: string; message?: string; data?: EmployeeCheckInResult } } })
    ?.response?.data
}

function httpStatus(err: unknown): number | null {
  const status = (err as { response?: { status?: number } })?.response?.status
  return typeof status === 'number' ? status : null
}

function beginInflight(ids: string[]): string[] {
  const take = ids.filter((id) => !inflightIds.has(id))
  take.forEach((id) => inflightIds.add(id))
  return take
}

function endInflight(ids: string[]) {
  ids.forEach((id) => inflightIds.delete(id))
}

/**
 * Sync 1 record đã enqueue (pending → syncing → synced | pending | failed).
 * 401 → pending (không failed). Khóa uuid với vòng sync queue.
 */
export async function syncCheckInRecord(
  id: string,
  options?: { notify?: boolean },
): Promise<SyncRecordKind> {
  const checkinList = useCheckinListStore()
  const authStore = useAuthStore()
  const t = i18n.global.t
  const notify = options?.notify !== false

  if (!authStore.isOnline || !authStore.token?.trim()) return 'skipped'
  if (!beginInflight([id]).length) return 'skipped'

  try {
    checkinList.recoverStaleSyncing()
    const emp =
      checkinList.offlineQueue.find((e) => e.id === id) ||
      checkinList.employees.find((e) => e.id === id)
    if (!emp || emp.status !== 'pending') return 'skipped'

    const ids = [id]
    checkinList.markQueueSyncing(ids)

    const routeNumber = authStore.resolveRouteNumber(emp.numberPlate || authStore.numberPlate)
    const employeeId = (emp.employeeId || emp.code || '').trim()
    const cardNumber = (emp.cardNumber || '').trim()

    if (!routeNumber) {
      checkinList.revertQueueSyncing(ids, false)
      return 'skipped'
    }

    try {
      const { data: body } = employeeId
        ? await employeeCheckInApi.createCheckInByEmployeeId({ routeNumber, employeeId })
        : await employeeCheckInApi.createCheckInByCardId({ routeNumber, cardNumber })

      if (isAlreadyRecorded(body)) {
        checkinList.applySyncResults(
          body.data
            ? [body.data]
            : [
              {
                employeeId,
                employeeName: emp.name || employeeId || cardNumber,
                cardNumber,
                checkInTime: emp.checkinAt,
              },
            ],
          ids,
        )
        return 'already'
      }

      if (isCheckInNotAvailable(body)) {
        checkinList.dropCheckInRecords(ids)
        if (notify) {
          showAppToast({
            severity: 'warn',
            summary: String(t('checkin.nfc.title')),
            detail: resolveApiMessage(body, 'error.CHECK_IN_NOT_AVAILABLE'),
            life: 3500,
          })
        }
        return 'unavailable'
      }

      if (!body?.success || !body.data) {
        checkinList.failQueueRecords(ids)
        if (notify) {
          showAppToast({
            severity: 'warn',
            summary: String(t('checkin.nfc.title')),
            detail: resolveApiMessage(body, 'checkin.nfc.checkInFailed'),
            life: 3500,
          })
        }
        return 'failed'
      }

      checkinList.applySyncResults([body.data], ids)
      return 'synced'
    } catch (err) {
      if (isAlreadyRecorded(errorPayload(err))) {
        const data = errorPayload(err)?.data
        checkinList.applySyncResults(
          data
            ? [data]
            : [
              {
                employeeId,
                employeeName: emp.name || employeeId || cardNumber,
                cardNumber,
                checkInTime: emp.checkinAt,
              },
            ],
          ids,
        )
        return 'already'
      }

      if (isCheckInNotAvailable(errorPayload(err))) {
        checkinList.dropCheckInRecords(ids)
        if (notify) {
          showAppToast({
            severity: 'warn',
            summary: String(t('checkin.nfc.title')),
            detail: resolveApiError(err, 'error.CHECK_IN_NOT_AVAILABLE'),
            life: 3500,
          })
        }
        return 'unavailable'
      }

      const status = httpStatus(err)
      if (status === 401) {
        checkinList.revertQueueSyncing(ids, false)
        return 'retry'
      }
      if (status == null || status >= 500) {
        checkinList.revertQueueSyncing(ids, true)
        return 'retry'
      }

      checkinList.failQueueRecords(ids)
      if (notify) {
        showAppToast({
          severity: 'error',
          summary: String(t('checkin.nfc.title')),
          detail: resolveApiError(err, 'checkin.nfc.checkInFailed'),
          life: 3500,
        })
      }
      return 'failed'
    }
  } finally {
    endInflight([id])
  }
}

/**
 * Đồng bộ queue từng uuid (một record lỗi không chặn các record khác).
 */
export async function syncOfflineQueue(options?: {
  silent?: boolean
  retryFailed?: boolean
}): Promise<boolean> {
  const checkinList = useCheckinListStore()
  const authStore = useAuthStore()
  const t = i18n.global.t

  if (syncing) return false
  if (!authStore.isOnline) return false
  if (!authStore.token?.trim()) {
    if (!options?.silent) {
      showAppToast({
        severity: 'warn',
        summary: String(t('checkin.sync.title')),
        detail: String(t('checkin.scan.hintNeedQr')),
        life: 4000,
      })
    }
    return false
  }

  if (options?.retryFailed) {
    checkinList.requeueFailedAsPending()
  }

  checkinList.recoverStaleSyncing()
  const pendingIds = checkinList.offlineReadyToSync
    .filter((emp) => !inflightIds.has(emp.id))
    .map((emp) => emp.id)
  if (!pendingIds.length) return false

  syncing = true
  let synced = 0
  let already = 0
  let failed = 0
  let unavailable = 0
  try {
    for (const id of pendingIds) {
      const kind = await syncCheckInRecord(id, { notify: false })
      if (kind === 'synced') synced++
      else if (kind === 'already') already++
      else if (kind === 'failed') failed++
      else if (kind === 'unavailable') unavailable++
    }

    const summary = String(t('checkin.sync.title'))
    // silent = tắt toast thành công (mạng lên / resume). Lỗi BE vẫn báo.
    if (synced > 0 && !options?.silent) {
      showAppToast({
        severity: 'success',
        summary,
        detail: String(t('checkin.sync.successToast')),
        life: 2200,
      })
    }
    if (unavailable > 0) {
      showAppToast({
        severity: 'warn',
        summary,
        detail: String(t('error.CHECK_IN_NOT_AVAILABLE')),
        life: 3500,
      })
    }
    if (already > 0) {
      showAppToast({
        severity: 'warn',
        summary,
        detail: String(t('error.ALREADY_CHECKED_IN')),
        life: 3200,
      })
    }
    if (failed > 0) {
      showAppToast({
        severity: 'warn',
        summary,
        detail: String(t('checkin.sync.failed')),
        life: 3200,
      })
    }

    if (unavailable > 0) {
      void speakImportantText('Xin thử lại. Bạn không phải làm ca hiện tại!')
    } else if (already > 0) {
      void speakImportantText(String(t('error.ALREADY_CHECKED_IN')))
    } else if (failed > 0) {
      void speakImportantText('Xin thử lại. Bạn không phải làm ca hiện tại!')
    } else if (synced > 0 && !options?.silent) {
      void speakImportantText('Xin cảm ơn')
    }

    return synced > 0 || already > 0
  } finally {
    syncing = false
  }
}
