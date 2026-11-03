import { defineStore } from 'pinia'
import dayjs from 'dayjs'
import type { EmployeeCheckInResult } from '@/api/employeeCheckIn'
import { formatVNWallClock, isCheckinAtInCurrentKickWindow } from '@/constants/kickSchedule'
import { CHECKIN_SYNC_MAX_RETRIES, CHECKIN_SYNCING_STALE_MS } from '@/constants/checkinSync'
import { isCheckinUuid, newCheckinUuid } from '@/utils/checkinUuid'

export type CheckinSyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

export interface CheckedInEmployee {
  id: string
  employeeId: string
  name: string
  code: string
  cardNumber: string
  checkinTime: string
  checkinAt: string
  initials: string
  color: string
  /** UI: chưa lên server (pending / syncing / failed) */
  pendingSync: boolean
  status: CheckinSyncStatus
  retryCount: number
  /** Epoch ms lúc chuyển syncing — dùng recover khi app bị kill */
  syncingAt: number | null
  numberPlate: string
}

const SYNC_STATUSES: CheckinSyncStatus[] = ['pending', 'syncing', 'synced', 'failed']

const AVATAR_COLORS = [
  '#2563eb',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#0ea5e9',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#84cc16',
  '#06b6d4',
  '#a855f7',
  '#22c55e',
  '#eab308',
  '#d946ef',
  '#f43f5e',
  '#3b82f6',
  '#059669',
  '#dc2626',
  '#7c3aed',
  '#0284c7',
  '#db2777',
  '#0d9488',
  '#ca8a04',
  '#65a30d',
  '#9333ea',
  '#e11d48',
  '#0891b2',
  '#4f46e5',
  '#c026d3',
]

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

function sortByNewest(a: CheckedInEmployee, b: CheckedInEmployee) {
  const tb = dayjs(b.checkinAt).valueOf()
  const ta = dayjs(a.checkinAt).valueOf()
  if (tb !== ta) return tb - ta
  return (b.id || '').localeCompare(a.id || '')
}

function plateMatches(empPlate: string, activePlate: string) {
  const a = activePlate.trim()
  if (!a) return true
  return (empPlate || '').trim() === a
}

/** List boarding: ẩn 4xx failed (giữ trong queue để retry). */
function isOnBoardingList(e: CheckedInEmployee, plate: string) {
  return (
    e.status !== 'failed' &&
    plateMatches(e.numberPlate, plate) &&
    isCheckinAtInCurrentKickWindow(e.checkinAt)
  )
}

function matchesCheckInKey(e: CheckedInEmployee, key: string, plate: string) {
  return (
    plateMatches(e.numberPlate, plate) &&
    isCheckinAtInCurrentKickWindow(e.checkinAt) &&
    (e.employeeId === key || e.cardNumber === key || e.code === key)
  )
}

function isBlockingCheckInStatus(status: CheckinSyncStatus) {
  return status === 'pending' || status === 'syncing' || status === 'synced'
}

const NAIVE_VN_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/

/** Giờ VN wall-clock cho list/kick/BE — không dùng UTC (`...Z`) */
export function toLocalCheckInTime(value?: string | Date | null) {
  if (value instanceof Date) {
    return formatVNWallClock(Number.isNaN(value.getTime()) ? new Date() : value)
  }
  const raw = String(value || '').trim()
  if (!raw) return formatVNWallClock()
  const naive = raw.match(NAIVE_VN_ISO)
  if (naive && !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) return naive[1]
  const d = dayjs(raw)
  return formatVNWallClock(d.isValid() ? d.toDate() : new Date())
}

/** Ngày + giờ hiển thị — lấy đúng chữ số wall-clock đã lưu (không lệch TZ máy). */
export function formatCheckinDisplay(checkinAt?: string | null, fallbackTime?: string) {
  if (!checkinAt) {
    return { date: '', time: fallbackTime || '' }
  }
  const stamp = toLocalCheckInTime(checkinAt)
  const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (match) {
    return {
      date: `${match[3]}/${match[2]}/${match[1]}`,
      time: `${match[4]}:${match[5]}:${match[6]}`,
    }
  }
  return {
    date: '',
    time: fallbackTime || '',
  }
}

function pendingSyncFromStatus(status: CheckinSyncStatus) {
  return status === 'pending' || status === 'syncing' || status === 'failed'
}

function parseStatus(value: unknown, pendingSync?: boolean): CheckinSyncStatus {
  if (typeof value === 'string' && SYNC_STATUSES.includes(value as CheckinSyncStatus)) {
    return value as CheckinSyncStatus
  }
  return pendingSync ? 'pending' : 'synced'
}

function normalizeEmployee(
  raw: Partial<CheckedInEmployee> & { id?: string; pendingSync?: boolean },
  index: number,
  idMap: Map<string, string>,
  queueFallbackPending = false,
): CheckedInEmployee {
  const oldId = String(raw.id || '')
  let id = oldId
  if (!isCheckinUuid(id)) {
    const mapped = idMap.get(oldId)
    if (mapped) {
      id = mapped
    } else {
      id = newCheckinUuid()
      if (oldId) idMap.set(oldId, id)
    }
  }

  const status = parseStatus(
    raw.status,
    raw.pendingSync === true || (raw.pendingSync == null && queueFallbackPending),
  )
  const retryCount = typeof raw.retryCount === 'number' && raw.retryCount >= 0 ? raw.retryCount : 0
  const syncingAt = typeof raw.syncingAt === 'number' ? raw.syncingAt : null
  const checkinAt = raw.checkinAt || toLocalCheckInTime()

  return {
    id,
    employeeId: raw.employeeId || '',
    name: raw.name || '',
    code: raw.code || raw.employeeId || '',
    cardNumber: raw.cardNumber || '',
    checkinTime: raw.checkinTime || formatCheckinDisplay(checkinAt).time,
    checkinAt,
    initials: raw.initials || getInitials(raw.name || raw.employeeId || raw.cardNumber || ''),
    color: raw.color || AVATAR_COLORS[index % AVATAR_COLORS.length],
    status,
    retryCount,
    syncingAt,
    pendingSync: pendingSyncFromStatus(status),
    numberPlate: (raw.numberPlate || '').trim(),
  }
}

function recoverIfStaleSyncing(emp: CheckedInEmployee, now = Date.now()): CheckedInEmployee {
  if (emp.status !== 'syncing') return emp
  const started = emp.syncingAt ?? 0
  if (!started || now - started > CHECKIN_SYNCING_STALE_MS) {
    return {
      ...emp,
      status: 'pending',
      syncingAt: null,
      pendingSync: true,
    }
  }
  return emp
}

function buildEmployee(
  result: EmployeeCheckInResult,
  pendingSync: boolean,
  numberPlate: string,
  index: number,
): CheckedInEmployee {
  const checkinAt = toLocalCheckInTime(result.checkInTime)
  const status: CheckinSyncStatus = pendingSync ? 'pending' : 'synced'
  return {
    id: newCheckinUuid(),
    employeeId: result.employeeId,
    name: result.employeeName,
    code: result.employeeId,
    cardNumber: result.cardNumber,
    checkinTime: formatCheckinDisplay(checkinAt).time,
    checkinAt,
    initials: getInitials(result.employeeName || result.employeeId || result.cardNumber),
    color: AVATAR_COLORS[index % AVATAR_COLORS.length],
    pendingSync,
    status,
    retryCount: 0,
    syncingAt: null,
    numberPlate: numberPlate.trim(),
  }
}

export const useCheckinListStore = defineStore('checkinList', {
  state: () => ({
    /**
     * Display + persist theo từng biển (edge B: filter theo activeDisplayPlate).
     * Kick chỉ clear mảng này; offlineQueue giữ đến khi sync OK theo từng bản ghi.
     */
    employees: [] as CheckedInEmployee[],
    /** Hàng đợi offline — giữ đến khi sync xong, cộng dồn nhiều ca / nhiều biển */
    offlineQueue: [] as CheckedInEmployee[],
    /** Biển đang xem trên UI step 2 (Select / Scan QR) */
    activeDisplayPlate: '' as string,
    /** Thời điểm Select biển số / Scan QR bắt đầu ca */
    tripStartedAt: null as string | null,
    /** Modal nhắc gửi offline (global) */
    reminderModalVisible: false,
  }),

  getters: {
    /**
     * Đã lên xe ca hiện tại theo biển đang xem.
     * Cộng dồn online/offline (cùng `employees` persist) đến khi kick reset → 0.
     */
    checkedInCount(state) {
      const plate = state.activeDisplayPlate
      return state.employees.filter((e) => isOnBoardingList(e, plate)).length
    },

    scannedEmployees(state) {
      const plate = state.activeDisplayPlate
      return state.employees.filter((e) => isOnBoardingList(e, plate)).slice().sort(sortByNewest)
    },

    offlinePendingEmployees: (state) => [...state.offlineQueue].sort(sortByNewest),

    offlinePendingCount: (state) => state.offlineQueue.length,

    /** Record sẵn sàng gửi (không gồm syncing đang lock / failed đã trần). */
    offlineReadyToSync(state) {
      return state.offlineQueue.filter((e) => e.status === 'pending')
    },

    isAlreadyCheckedIn(state) {
      return (code: string, plate?: string) => {
        const key = code.trim()
        if (!key) return false
        const p = (plate ?? state.activeDisplayPlate).trim()
        const matches = (e: CheckedInEmployee) =>
          isBlockingCheckInStatus(e.status) && matchesCheckInKey(e, key, p)
        return state.employees.some(matches) || state.offlineQueue.some(matches)
      }
    },
  },

  actions: {
    /** Cập nhật biển đang xem — không xóa list biển khác (edge B). */
    setActivePlate(plate: string) {
      this.activeDisplayPlate = plate.trim()
    },

    startTrip() {
      this.tripStartedAt = toLocalCheckInTime()
    },

    addEmployee(result: EmployeeCheckInResult, pendingSync = false, numberPlate = '') {
      const plate = numberPlate.trim() || this.activeDisplayPlate
      const emp = buildEmployee(
        result,
        pendingSync,
        plate,
        this.employees.length + this.offlineQueue.length,
      )
      this.employees.unshift(emp)
      if (pendingSync) {
        this.offlineQueue.unshift({ ...emp })
      }
      return emp
    },

    /**
     * Source of truth: luôn ghi local pending trước khi gọi API.
     * Trùng ca (pending/syncing/synced) → null.
     * Cùng mã đã failed → đưa lại pending (cùng uuid), không tạo record mới.
     */
    enqueueCheckIn(
      result: EmployeeCheckInResult,
      numberPlate = '',
    ): CheckedInEmployee | null {
      const plate = numberPlate.trim() || this.activeDisplayPlate
      const key = (result.employeeId || result.cardNumber || '').trim()
      if (key && this.isAlreadyCheckedIn(key, plate)) return null
      if (key) {
        const revived = this.requeueFailedMatch(key, plate)
        if (revived) return revived
      }
      return this.addEmployee(result, true, plate)
    },

    requeueFailedMatch(key: string, plate: string): CheckedInEmployee | null {
      const inQueue = this.offlineQueue.find(
        (e) => e.status === 'failed' && matchesCheckInKey(e, key, plate),
      )
      if (!inQueue) return null
      const revive = (emp: CheckedInEmployee) => {
        if (emp.id !== inQueue.id) return
        emp.status = 'pending'
        emp.retryCount = 0
        emp.syncingAt = null
        emp.pendingSync = true
      }
      this.offlineQueue.forEach(revive)
      this.employees.forEach(revive)
      if (!this.employees.some((e) => e.id === inQueue.id)) {
        this.employees.unshift({ ...inQueue, status: 'pending', retryCount: 0, syncingAt: null, pendingSync: true })
      }
      return this.offlineQueue.find((e) => e.id === inQueue.id) || inQueue
    },

    /**
     * Mốc đá: chỉ xóa display list.
     * Không đụng offlineQueue. (step 1 do kickWatcher / App gọi riêng — tránh circular store)
     */
    resetDisplayList() {
      this.employees = []
      this.tripStartedAt = null
      this.reminderModalVisible = false
    },

    async showReminderModal(withTts: boolean) {
      if (this.offlineQueue.length === 0) return
      this.reminderModalVisible = true
      const [{ vibrateHeavy, playBeep }, { speakImportantText }] = await Promise.all([
        import('@/services/alertSound'),
        import('@/services/ttsService'),
      ])
      await vibrateHeavy()
      await playBeep()
      if (withTts) {
        await speakImportantText('Vui lòng gửi dữ liệu offline trước giờ checkin')
      }
    },

    closeReminderModal() {
      this.reminderModalVisible = false
    },

    /**
     * Sau sync thành công: chỉ vá theo uuid (không tìm employeeId/card — tránh nhầm biển).
     * Chỉ xóa khỏi offlineQueue các bản ghi trong syncedQueueIds.
     */
    applySyncResults(results?: EmployeeCheckInResult[] | null, syncedQueueIds?: string[]) {
      const ids = (syncedQueueIds || []).filter(Boolean)
      if (!ids.length) return

      const idSet = new Set(ids)
      const result = Array.isArray(results) && results.length === 1 ? results[0] : null
      const empId = (result?.employeeId || '').trim()
      const card = (result?.cardNumber || '').trim()

      const patchById = (emp: CheckedInEmployee) => {
        if (!idSet.has(emp.id)) return
        if (result) {
          if (result.employeeName) {
            emp.name = result.employeeName
            emp.initials = getInitials(result.employeeName)
          }
          if (empId) {
            emp.employeeId = empId
            emp.code = empId
          }
          if (card) emp.cardNumber = card
          if (result.checkInTime && dayjs(result.checkInTime).isValid()) {
            emp.checkinAt = toLocalCheckInTime(result.checkInTime)
            emp.checkinTime = formatCheckinDisplay(emp.checkinAt).time
          }
        }
        emp.pendingSync = false
        emp.status = 'synced'
        emp.syncingAt = null
      }

      this.employees.forEach(patchById)
      this.offlineQueue.forEach(patchById)
      this.offlineQueue = this.offlineQueue.filter((e) => !idSet.has(e.id))

      if (this.offlineQueue.length === 0) {
        this.reminderModalVisible = false
      }
    },

    markQueueSyncing(ids: string[]) {
      const idSet = new Set(ids)
      const now = Date.now()
      this.offlineQueue.forEach((emp) => {
        if (!idSet.has(emp.id) || emp.status !== 'pending') return
        emp.status = 'syncing'
        emp.syncingAt = now
        emp.pendingSync = true
      })
      this.employees.forEach((emp) => {
        if (!idSet.has(emp.id) || emp.status !== 'pending') return
        emp.status = 'syncing'
        emp.syncingAt = now
        emp.pendingSync = true
      })
    },

    /**
     * Sync fail / crash recover: syncing → pending, hoặc failed khi hết retry.
     * Không xóa khỏi queue.
     */
    revertQueueSyncing(ids: string[], incrementRetry = true) {
      const idSet = new Set(ids)
      const apply = (emp: CheckedInEmployee) => {
        if (!idSet.has(emp.id) || emp.status !== 'syncing') return
        const retryCount = incrementRetry ? emp.retryCount + 1 : emp.retryCount
        const failed = retryCount >= CHECKIN_SYNC_MAX_RETRIES
        emp.retryCount = retryCount
        emp.status = failed ? 'failed' : 'pending'
        emp.syncingAt = null
        emp.pendingSync = true
      }
      this.offlineQueue.forEach(apply)
      this.employees.forEach(apply)
    },

    failQueueRecords(ids: string[]) {
      const idSet = new Set(ids)
      const apply = (emp: CheckedInEmployee) => {
        if (!idSet.has(emp.id)) return
        emp.status = 'failed'
        emp.syncingAt = null
        emp.pendingSync = true
      }
      this.offlineQueue.forEach(apply)
      this.employees.forEach(apply)
    },

    /** BE CHECK_IN_NOT_AVAILABLE — gỡ display + queue (retry không lên được ca). */
    dropCheckInRecords(ids: string[]) {
      const idSet = new Set(ids)
      this.employees = this.employees.filter((e) => !idSet.has(e.id))
      this.offlineQueue = this.offlineQueue.filter((e) => !idSet.has(e.id))
      if (this.offlineQueue.length === 0) {
        this.reminderModalVisible = false
      }
    },

    /** QR lại / bấm Sync: cho failed về pending để gửi lại (không gồm đang syncing). */
    requeueFailedAsPending() {
      const apply = (emp: CheckedInEmployee) => {
        if (emp.status !== 'failed') return
        emp.status = 'pending'
        emp.retryCount = 0
        emp.syncingAt = null
        emp.pendingSync = true
      }
      this.offlineQueue.forEach(apply)
      this.employees.forEach(apply)
    },

    recoverStaleSyncing() {
      this.offlineQueue = this.offlineQueue.map((e) => recoverIfStaleSyncing(e))
      this.employees = this.employees.map((e) => recoverIfStaleSyncing(e))
    },

    /** Xóa hết (logout) — kể cả offline queue */
    clearAll() {
      this.employees = []
      this.offlineQueue = []
      this.activeDisplayPlate = ''
      this.tripStartedAt = null
      this.reminderModalVisible = false
    },
  },

  persist: {
    key: 'vip_checkin_list',
    pick: ['employees', 'offlineQueue', 'activeDisplayPlate', 'tripStartedAt'],
  },
})

/** Migrate persist cũ: uuid + status từ pendingSync; recover syncing kẹt. */
export function migrateCheckinListStore() {
  const store = useCheckinListStore()
  if (!Array.isArray(store.offlineQueue)) store.offlineQueue = []
  if (!Array.isArray(store.employees)) store.employees = []

  if (!store.offlineQueue.length && store.employees.length) {
    const pending = store.employees.filter((e) => e.pendingSync || e.status === 'pending')
    if (pending.length) {
      store.offlineQueue = pending.map((e) => ({
        ...e,
        numberPlate: e.numberPlate || '',
      }))
    }
  }

  const idMap = new Map<string, string>()
  store.employees = store.employees.map((e, i) => normalizeEmployee(e, i, idMap, false))
  store.offlineQueue = store.offlineQueue.map((e, i) =>
    normalizeEmployee(e, i + store.employees.length, idMap, true),
  )

  store.recoverStaleSyncing()

  if (typeof store.activeDisplayPlate !== 'string') {
    store.activeDisplayPlate = ''
  }
}
