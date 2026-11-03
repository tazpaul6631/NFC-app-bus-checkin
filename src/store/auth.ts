import { defineStore } from 'pinia'
import { Preferences } from '@capacitor/preferences'
import storageService from '@/services/storage.service'
import type { DriverPlateItem } from '@/api/driverLogin'
import {
  CACHED_PLATES_KEY,
  CACHED_PLATES_SYNC_KEY,
  formatVehicleLabel,
  fromDriverPlateItem,
  loadCachedNumberPlates,
  saveCachedNumberPlates,
  type CachedVehicle,
} from '@/services/vehiclePlateCache'
import router from '@/router'

/** Lazy — tránh circular import auth ↔ checkinList lúc init module */
async function getCheckinListStore() {
  const { useCheckinListStore } = await import('@/store/checkinList')
  return useCheckinListStore()
}

export interface AuthUser {
  id: string
  name: string
  role: string
}

export interface DriverSession {
  numberPlate: string
  accessToken: string
  expiresAt: string
  routeNumber?: string | null
  numOfSeat?: number | null
  registeredCount?: number | null
}

export type { CachedVehicle }

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    token: '',
    numberPlate: '' as string,
    /** Chỉ lưu token expiry từ BE — không dùng để clear danh sách điểm danh */
    expiresAt: null as string | null,
    /** Cache xe (biển + ghế + đăng ký) — kick không xóa */
    cachedVehicles: [] as CachedVehicle[],
    /** Stats xe đang chọn (step 2) */
    activeNumOfSeat: null as number | null,
    activeRegisteredCount: null as number | null,
    isOnline: true,
    lastSync: null as string | null,
    platesHydrated: false,
  }),

  getters: {
    isAuthenticated: (state) => !!state.token,
    getUserName: (state) => state.user?.name || 'Guest',
    cachedNumberPlates: (state) => state.cachedVehicles.map((v) => v.numberPlate),
    offlineVehicleOptions: (state) =>
      state.cachedVehicles.map((v) => ({
        label: formatVehicleLabel(v.routeNumber, v.numberPlate),
        value: v.numberPlate,
        routeNumber: v.routeNumber,
      })),
  },

  actions: {
    setToken(token: string) {
      this.token = token
      void Preferences.set({ key: 'vip_token', value: token })
    },

    findCachedVehicle(plate: string) {
      const key = plate.trim()
      if (!key) return undefined
      return this.cachedVehicles.find((v) => v.numberPlate === key)
    },

    upsertCachedVehicle(vehicle: CachedVehicle) {
      const plate = vehicle.numberPlate.trim()
      if (!plate) return
      const next: CachedVehicle = {
        numberPlate: plate,
        routeNumber: vehicle.routeNumber?.trim() || null,
        numOfSeat: vehicle.numOfSeat ?? null,
        registeredCount: vehicle.registeredCount ?? null,
      }
      const idx = this.cachedVehicles.findIndex((v) => v.numberPlate === plate)
      if (idx >= 0) {
        const prev = this.cachedVehicles[idx]
        this.cachedVehicles[idx] = {
          numberPlate: plate,
          routeNumber: next.routeNumber ?? prev.routeNumber,
          numOfSeat: next.numOfSeat ?? prev.numOfSeat,
          registeredCount: next.registeredCount ?? prev.registeredCount,
        }
      } else {
        this.cachedVehicles.push(next)
      }
      void saveCachedNumberPlates(this.cachedVehicles)
    },

    setActiveVehicleMeta(
      plate: string,
      meta?: {
        routeNumber?: string | null
        numOfSeat?: number | null
        registeredCount?: number | null
      },
    ) {
      const cached = this.findCachedVehicle(plate)
      this.activeNumOfSeat = meta?.numOfSeat ?? cached?.numOfSeat ?? null
      this.activeRegisteredCount = meta?.registeredCount ?? cached?.registeredCount ?? null
      if (
        meta?.routeNumber != null ||
        meta?.numOfSeat != null ||
        meta?.registeredCount != null
      ) {
        this.upsertCachedVehicle({
          numberPlate: plate,
          routeNumber: meta.routeNumber ?? cached?.routeNumber ?? null,
          numOfSeat: meta.numOfSeat ?? cached?.numOfSeat ?? null,
          registeredCount: meta.registeredCount ?? cached?.registeredCount ?? null,
        })
      }
    },

    setDriverSession(session: DriverSession) {
      const nextPlate = session.numberPlate.trim()
      // Edge B: không xóa list biển khác — chỉ đổi biển đang xem (filter UI)
      void getCheckinListStore().then((checkinList) => {
        checkinList.setActivePlate(nextPlate)
      })

      this.setToken(session.accessToken)
      this.numberPlate = nextPlate
      this.expiresAt = session.expiresAt
      this.setActiveVehicleMeta(nextPlate, {
        routeNumber: session.routeNumber,
        numOfSeat: session.numOfSeat,
        registeredCount: session.registeredCount,
      })
    },

    async setCachedVehicles(items: DriverPlateItem[] | CachedVehicle[]) {
      const prevByPlate = new Map(
        this.cachedVehicles.map((v) => [v.numberPlate, v] as const),
      )
      const unique = new Map<string, CachedVehicle>()
      for (const item of items) {
        const v = fromDriverPlateItem(item) ?? null
        if (!v) continue
        const prev = prevByPlate.get(v.numberPlate)
        // GetVehicles thiếu/null seat|registered|route → giữ cache login (tránh offline Select ra —/—)
        unique.set(v.numberPlate, {
          numberPlate: v.numberPlate,
          routeNumber: v.routeNumber ?? prev?.routeNumber ?? null,
          numOfSeat: v.numOfSeat ?? prev?.numOfSeat ?? null,
          registeredCount: v.registeredCount ?? prev?.registeredCount ?? null,
        })
      }
      this.cachedVehicles = [...unique.values()]
      this.lastSync = new Date().toISOString()
      this.platesHydrated = true
      await saveCachedNumberPlates(this.cachedVehicles)
      if (this.numberPlate) {
        this.setActiveVehicleMeta(this.numberPlate)
      }
    },

    /** @deprecated dùng setCachedVehicles — giữ alias cho chỗ gọi cũ */
    async setCachedNumberPlates(plates: string[]) {
      await this.setCachedVehicles(
        plates.map((p) => ({
          numberPlate: p,
          routeNumber: null,
          numOfSeat: null,
          registeredCount: null,
        })),
      )
    },

    async hydrateCachedNumberPlates() {
      try {
        const { vehicles, lastSync } = await loadCachedNumberPlates()

        if (vehicles.length > 0) {
          this.cachedVehicles = vehicles
          if (lastSync) this.lastSync = lastSync
        } else if (this.cachedVehicles.length > 0) {
          await saveCachedNumberPlates(this.cachedVehicles)
        }

        if (this.numberPlate) {
          this.setActiveVehicleMeta(this.numberPlate)
        }
      } finally {
        this.platesHydrated = true
      }
    },

    setNetworkStatus(status: boolean) {
      this.isOnline = status
    },

    async login(username: string, _password: string) {
      const token = `demo-token-${Date.now()}`
      this.setToken(token)
      this.user = {
        id: '1',
        name: username || 'Admin',
        role: 'Developer',
      }
      await router.push({ name: 'CheckinFlow' })
    },

    async changePassword(currentPassword: string, newPassword: string) {
      if (!currentPassword || !newPassword) {
        throw new Error('Invalid password')
      }
      await new Promise((resolve) => setTimeout(resolve, 600))
    },

    /**
     * 401 / session hết hạn: xóa token + cache Select (biển/tuyến) + về step 1.
     * Giữ offlineQueue / display list — sync khi quét QR lấy token mới.
     */
    async clearSession() {
      this.token = ''
      this.expiresAt = null
      this.numberPlate = ''
      this.cachedVehicles = []
      this.activeNumOfSeat = null
      this.activeRegisteredCount = null
      this.lastSync = null
      await Preferences.remove({ key: 'vip_token' })
      await storageService.remove('vip_token')
      await storageService.remove(CACHED_PLATES_KEY)
      await storageService.remove(CACHED_PLATES_SYNC_KEY)
      const { useCheckinStepStore } = await import('@/store/checkinStep')
      useCheckinStepStore().reset()
    },

    async logout() {
      const checkinList = await getCheckinListStore()
      checkinList.clearAll()
      this.token = ''
      this.user = null
      this.numberPlate = ''
      this.expiresAt = null
      this.activeNumOfSeat = null
      this.activeRegisteredCount = null
      await Preferences.remove({ key: 'vip_token' })
      await storageService.remove('vip_token')
      const { useCheckinStepStore } = await import('@/store/checkinStep')
      useCheckinStepStore().reset()
      await router.push({ name: 'CheckinFlow' })
    },
  },

  persist: {
    key: 'vip_auth_storage',
    pick: [
      'token',
      'user',
      'numberPlate',
      'expiresAt',
      'cachedVehicles',
      'activeNumOfSeat',
      'activeRegisteredCount',
      'lastSync',
    ],
  },
})
