export interface Server {
    id: string;
    orgId: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authType: 'key' | 'password';
    defaultKeyId?: string;
    tags: string[];
    notes?: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}
export interface CreateServerRequest {
    name: string;
    host: string;
    port?: number;
    username: string;
    authType?: 'key' | 'password';
    defaultKeyId?: string;
    password?: string;
    tags?: string[];
    notes?: string;
}
export interface UpdateServerRequest {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    authType?: 'key' | 'password';
    defaultKeyId?: string;
    password?: string;
    tags?: string[];
    notes?: string;
}
export interface ServerGroup {
    id: string;
    orgId: string;
    name: string;
    serverIds: string[];
    createdAt: string;
    updatedAt: string;
}
//# sourceMappingURL=server.d.ts.map