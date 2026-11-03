import type { DriverPlateItem } from '@/api/driverLogin'
import storageService from '@/services/storage.service'

export const CACHED_PLATES_KEY = 'vip_cached_number_plates'
export const CACHED_PLATES_SYNC_KEY = 'vip_cached_number_plates_last_sync'

export interface CachedVehicle {
  numberPlate: string
  routeNumber: string | null
  numOfSeat: number | null
  registeredCount: number | null
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toNullableString(value: unknown): string | null {
  const s = String(value ?? '').trim()
  return s || null
}

/** `routeNumber (numberPlate)` khi có route; không thì chỉ biển. */
export function formatVehicleLabel(
  routeNumber: string | null | undefined,
  numberPlate: string,
) {
  const route = String(routeNumber || '').trim()
  const plate = numberPlate.trim()
  return route ? `${route} (${plate})` : plate
}

export function normalizeCachedVehicle(input: unknown): CachedVehicle | null {
  if (typeof input === 'string') {
    const plate = input.trim()
    if (!plate) return null
    return { numberPlate: plate, routeNumber: null, numOfSeat: null, registeredCount: null }
  }
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string, unknown>
  const plate = String(row.numberPlate || '').trim()
  if (!plate) return null
  return {
    numberPlate: plate,
    routeNumber: toNullableString(row.routeNumber),
    numOfSeat: toNullableNumber(row.numOfSeat),
    registeredCount: toNullableNumber(row.registeredCount),
  }
}

export function fromDriverPlateItem(item: DriverPlateItem): CachedVehicle | null {
  return normalizeCachedVehicle(item)
}

/** Lưu danh sách xe xuống Preferences (ghi đè toàn bộ). */
export async function saveCachedNumberPlates(vehicles: CachedVehicle[]): Promise<void> {
  const unique = new Map<string, CachedVehicle>()
  for (const v of vehicles) {
    const plate = v.numberPlate.trim()
    if (!plate) continue
    unique.set(plate, {
      numberPlate: plate,
      routeNumber: v.routeNumber?.trim() || null,
      numOfSeat: v.numOfSeat ?? null,
      registeredCount: v.registeredCount ?? null,
    })
  }
  await storageService.set(CACHED_PLATES_KEY, [...unique.values()])
  await storageService.set(CACHED_PLATES_SYNC_KEY, new Date().toISOString())
}

/** Đọc danh sách xe từ Preferences (migrate bản cũ: string[]). */
export async function loadCachedNumberPlates(): Promise<{
  vehicles: CachedVehicle[]
  lastSync: string | null
}> {
  const raw = await storageService.get(CACHED_PLATES_KEY, true)
  const lastSync = (await storageService.get(CACHED_PLATES_SYNC_KEY)) as string | null

  if (!Array.isArray(raw)) {
    return { vehicles: [], lastSync: lastSync || null }
  }

  const unique = new Map<string, CachedVehicle>()
  for (const item of raw) {
    const v = normalizeCachedVehicle(item)
    if (!v) continue
    unique.set(v.numberPlate, v)
  }

  return { vehicles: [...unique.values()], lastSync: lastSync || null }
}
