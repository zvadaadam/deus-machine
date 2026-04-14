export interface ApiError {
  status: number;
  message: string;
  details?: any;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}
