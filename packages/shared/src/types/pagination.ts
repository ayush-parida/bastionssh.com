export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}
