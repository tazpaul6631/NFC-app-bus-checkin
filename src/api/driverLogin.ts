import request from '@/services/api'

export interface DriverLoginData {
    numberPlate: string
    accessToken: string
    expiresAt: string
    routeNumber?: string | null
    numOfSeat?: number | null
    registeredCount?: number | null
}

export interface DriverLoginResponse {
    success: boolean
    message: string
    status?: string
    data: DriverLoginData
}

export interface DriverPlateItem {
    numberPlate: string
    routeNumber?: string | null
    numOfSeat?: number | null
    registeredCount?: number | null
}

export interface DriverPlateListResponse {
    success: boolean
    message: string
    status?: string
    data: DriverPlateItem[]
}

export default {
    postDriverLogin(data: { numberPlate: string }) {
        return request.post<DriverLoginResponse>(`sbr/DriverLogin/Login`, data)
    },

    getVehicles(params?: unknown) {
        return request.get<DriverPlateListResponse>(`sbr/DriverLogin/GetVehicles`, params)
    },
}
