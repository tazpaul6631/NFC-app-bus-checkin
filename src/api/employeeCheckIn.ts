import request from '@/services/api'

/** Request: điểm danh bằng số thẻ NFC */
export interface CreateCheckInByCardRequest {
  routeNumber: string
  cardNumber: string
}

/** Request: điểm danh bằng mã nhân viên (barcode) */
export interface CreateCheckInByEmployeeIdRequest {
  routeNumber: string
  employeeId: string
}

/** Một bản ghi sync offline */
export interface EmployeeCheckInSyncItem {
  routeNumber: string
  cardNumber: string
  employeeId: string
  checkInTime: string
  /** Uuid local — chỉ gửi khi SEND_CHECKIN_IDEMPOTENCY_KEY = true */
  clientRequestId?: string
}

/** Request: đồng bộ danh sách điểm danh offline */
export interface CreateCheckInSyncDataRequest {
  data: EmployeeCheckInSyncItem[]
}

/** Data trả về khi create check-in thành công */
export interface EmployeeCheckInResult {
  employeeId: string
  employeeName: string
  cardNumber: string
  checkInTime: string
}

export interface EmployeeCheckInResponse {
  success: boolean
  message: string
  status?: string
  data: EmployeeCheckInResult
}

/**
 * Response sync: hiện tại BE chỉ trả success + message.
 * `data` optional — nếu sau này BE trả list thì FE merge vào store.
 */
export interface EmployeeCheckInSyncResponse {
  success: boolean
  message: string
  status?: string
  data?: EmployeeCheckInResult[] | null
}

export default {
  createCheckInByCardId(data: CreateCheckInByCardRequest) {
    return request.post<EmployeeCheckInResponse>(`sbr/EmployeeCheckIn/CreateEmployeeCheckIn`, data)
  },

  createCheckInByEmployeeId(data: CreateCheckInByEmployeeIdRequest) {
    return request.post<EmployeeCheckInResponse>(
      `sbr/EmployeeCheckIn/CreateEmployeeCheckInByEmployeeId`,
      data,
    )
  },

  createCheckInSyncData(data: CreateCheckInSyncDataRequest) {
    return request.post<EmployeeCheckInSyncResponse>(
      `sbr/EmployeeCheckIn/CreateEmployeeCheckInSyncData`,
      data,
    )
  },
}
