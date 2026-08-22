export interface SiYuanResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export interface Notebook {
  id: string;
  name: string;
  icon: string;
  sort: number;
  sortMode: number;
  closed: boolean;
}

export interface FileTreeItem {
  path: string;
  name: string;
  id: string;
  subFileCount: number;
  size: number;
  mtime: number;
  ctime: number;
  sort: number;
  hidden: boolean;
}

export class SiYuanApi {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private async post<T>(path: string, payload: Record<string, unknown> = {}): Promise<T> {
    const resp = await fetch(this.url(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as SiYuanResponse<T>;
    if (json.code !== 0) {
      throw new Error(json.msg || `API error: ${path}`);
    }
    return json.data;
  }

  async listNotebooks(): Promise<Notebook[]> {
    const data = await this.post<{ notebooks: Notebook[] }>('/api/notebook/lsNotebooks');
    return data.notebooks;
  }

  async createNotebook(name: string): Promise<Notebook> {
    const data = await this.post<{ notebook: Notebook }>('/api/notebook/createNotebook', { name });
    return data.notebook;
  }

  async listDocsByPath(notebookId: string, path = '/'): Promise<FileTreeItem[]> {
    const data = await this.post<{ files: FileTreeItem[] }>('/api/filetree/listDocsByPath', {
      notebook: notebookId,
      path,
    });
    return data.files;
  }

  async getHPathByID(id: string): Promise<string> {
    return this.post<string>('/api/filetree/getHPathByID', { id });
  }

  async createDocWithMd(notebookId: string, path: string, markdown: string): Promise<string> {
    return this.post<string>('/api/filetree/createDocWithMd', {
      notebook: notebookId,
      path,
      markdown,
    });
  }

  async removeDoc(notebookId: string, path: string): Promise<void> {
    await this.post('/api/filetree/removeDoc', { notebook: notebookId, path });
  }

  async uploadAsset(fileName: string, data: ArrayBuffer, mime: string): Promise<string> {
    const blob = new Blob([data], { type: mime });
    const form = new FormData();
    form.append('assetsDirPath', '/assets/');
    form.append('file[]', blob, fileName);
    const resp = await fetch(this.url('/api/asset/upload'), {
      method: 'POST',
      headers: { Authorization: `Token ${this.token}` },
      body: form,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as SiYuanResponse<{ errFiles: string[] | null; succMap: Record<string, string> }>;
    if (json.code !== 0) {
      throw new Error(json.msg || `API error: upload asset`);
    }
    const path = json.data.succMap[fileName];
    if (!path) {
      throw new Error(`Upload failed: ${(json.data.errFiles ?? []).join(', ') || 'no result'}`);
    }
    return path;
  }
}
