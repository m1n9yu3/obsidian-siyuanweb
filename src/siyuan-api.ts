export function unwrapStoragePath(data: unknown, id: string): string {
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object' && 'path' in data) {
    const path = (data as { path?: unknown }).path;
    if (typeof path === 'string' && path.trim()) return path;
  }
  return `/${id}.sy`;
}

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
  hidden?: boolean;
}

export interface ChildBlock {
  id: string;
  type?: string;
  subType?: string;
}

function isHttp404(error: unknown): boolean {
  return error instanceof Error && /HTTP 404\b/.test(error.message);
}

function isRetryableNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.message} ${error.name}` : String(error);
  const cause = error instanceof Error && 'cause' in error ? String((error as { cause?: unknown }).cause) : '';
  return /fetch failed|Headers Timeout|UND_ERR|ECONNRESET|ETIMEDOUT|ECONNREFUSED|HTTP 502|HTTP 503|HTTP 504/i.test(
    `${msg} ${cause}`,
  );
}

export class SiYuanApi {
  /** Older kernels only have path-based filetree APIs. null = not probed yet. */
  private idFileTreeApis: boolean | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private async post<T>(path: string, payload: Record<string, unknown> = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.postOnce<T>(path, payload);
      } catch (error) {
        lastError = error;
        if (!isRetryableNetworkError(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async postOnce<T>(path: string, payload: Record<string, unknown>): Promise<T> {
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
    const data = await this.post<{ notebooks: Notebook[] | null }>('/api/notebook/lsNotebooks');
    return data?.notebooks ?? [];
  }

  async openNotebook(id: string): Promise<void> {
    await this.post('/api/notebook/openNotebook', { notebook: id });
  }

  async createNotebook(name: string): Promise<Notebook> {
    const data = await this.post<{ notebook: Notebook }>('/api/notebook/createNotebook', { name });
    return data.notebook;
  }

  async listDocsByPath(notebookId: string, path = '/'): Promise<FileTreeItem[]> {
    const data = await this.post<{ files: FileTreeItem[] | null }>('/api/filetree/listDocsByPath', {
      notebook: notebookId,
      path,
      maxListCount: 102400,
      ignoreMaxListHint: true,
      showHidden: true,
    });
    return data?.files ?? [];
  }

  async getHPathByID(id: string): Promise<string> {
    return this.post<string>('/api/filetree/getHPathByID', { id });
  }

  async createDocWithMd(
    notebookId: string,
    path: string,
    markdown: string,
    opts?: { parentID?: string },
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      notebook: notebookId,
      path,
      markdown,
    };
    if (opts?.parentID) payload.parentID = opts.parentID;
    return this.post<string>('/api/filetree/createDocWithMd', payload);
  }

  async getIDsByHPath(notebookId: string, hPath: string): Promise<string[]> {
    const data = await this.post<string[] | null>('/api/filetree/getIDsByHPath', {
      notebook: notebookId,
      path: hPath,
    });
    return data ?? [];
  }

  async renameDocByID(id: string, title: string): Promise<void> {
    if (this.idFileTreeApis !== false) {
      try {
        await this.post('/api/filetree/renameDocByID', { id, title });
        this.idFileTreeApis = true;
        return;
      } catch (error) {
        if (!isHttp404(error)) throw error;
        this.idFileTreeApis = false;
      }
    }
    const path = await this.getPathByID(id);
    const notebook = await this.getBoxByID(id);
    await this.post('/api/filetree/renameDoc', { notebook, path, title });
  }

  async moveDocsByID(fromIDs: string[], toID: string): Promise<void> {
    if (fromIDs.length === 0) return;
    if (this.idFileTreeApis !== false) {
      try {
        await this.post('/api/filetree/moveDocsByID', { fromIDs, toID });
        this.idFileTreeApis = true;
        return;
      } catch (error) {
        if (!isHttp404(error)) throw error;
        this.idFileTreeApis = false;
      }
    }
    const fromPaths: string[] = [];
    for (const id of fromIDs) fromPaths.push(await this.getPathByID(id));
    const target = await this.resolveMoveTarget(toID);
    await this.post('/api/filetree/moveDocs', {
      fromPaths,
      toNotebook: target.notebook,
      toPath: target.path,
    });
  }

  async removeDoc(notebookId: string, path: string): Promise<void> {
    await this.post('/api/filetree/removeDoc', { notebook: notebookId, path });
  }

  async removeDocByID(id: string): Promise<void> {
    if (this.idFileTreeApis !== false) {
      try {
        await this.post('/api/filetree/removeDocByID', { id });
        this.idFileTreeApis = true;
        return;
      } catch (error) {
        if (!isHttp404(error)) throw error;
        this.idFileTreeApis = false;
      }
    }
    const path = await this.getPathByID(id);
    const notebook = await this.getBoxByID(id);
    await this.removeDoc(notebook, path);
  }

  async getBoxByID(id: string): Promise<string> {
    if (!/^\d{14}-[a-z0-9]+$/i.test(id)) {
      throw new Error('Invalid id');
    }
    const data = await this.post<Array<{ box?: string }> | null>('/api/query/sql', {
      stmt: `SELECT box FROM blocks WHERE id = '${id}' LIMIT 1`,
    });
    const box = data?.[0]?.box;
    if (!box) throw new Error(`Notebook not found for ${id}`);
    return String(box);
  }

  private async resolveMoveTarget(toID: string): Promise<{ notebook: string; path: string }> {
    try {
      const data = await this.post<unknown>('/api/filetree/getPathByID', { id: toID });
      const path = unwrapStoragePath(data, toID);
      if (data && typeof data === 'object' && 'notebook' in data) {
        const notebook = String((data as { notebook?: unknown }).notebook ?? '');
        if (notebook) return { notebook, path };
      }
      const box = await this.getBoxByID(toID).catch(() => '');
      if (box) return { notebook: box, path };
    } catch {
      /* toID may be a notebook id */
    }
    return { notebook: toID, path: '/' };
  }

  async flushTransaction(): Promise<void> {
    await this.post('/api/sqlite/flushTransaction');
  }

  async getPathByID(id: string): Promise<string> {
    const data = await this.post<unknown>('/api/filetree/getPathByID', { id });
    return unwrapStoragePath(data, id);
  }

  async queryDocs(notebookId: string): Promise<Array<{ id: string; hpath: string; path: string }>> {
    if (!/^\d{14}-[a-z0-9]+$/i.test(notebookId)) {
      throw new Error('Invalid notebook id');
    }
    await this.flushTransaction();
    const data = await this.post<Array<{ id?: string; hpath?: string; path?: string }> | null>(
      '/api/query/sql',
      {
        stmt: `SELECT id, hpath, path FROM blocks WHERE type = 'd' AND box = '${notebookId}' LIMIT 100000`,
      },
    );
    return (data ?? [])
      .filter((row) => Boolean(row.id))
      .map((row) => ({
        id: String(row.id),
        hpath: String(row.hpath ?? '/'),
        path: String(row.path ?? '') || `/${row.id}.sy`,
      }));
  }

  async getChildBlocks(id: string): Promise<ChildBlock[]> {
    const data = await this.post<ChildBlock[] | null>('/api/block/getChildBlocks', { id });
    return data ?? [];
  }

  async deleteBlock(id: string): Promise<void> {
    await this.post('/api/block/deleteBlock', { id });
  }

  async appendBlock(parentID: string, markdown: string): Promise<void> {
    await this.post('/api/block/appendBlock', {
      dataType: 'markdown',
      data: markdown,
      parentID,
    });
  }

  /** Replace a document's content blocks without deleting sub-documents. */
  async updateDocMarkdown(id: string, markdown: string): Promise<void> {
    const children = await this.getChildBlocks(id);
    if (markdown.length > 0) {
      await this.appendBlock(id, markdown);
    }
    for (const child of [...children].reverse()) {
      await this.deleteBlock(child.id);
    }
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
    const json = (await resp.json()) as SiYuanResponse<{
      errFiles: string[] | null;
      succMap: Record<string, string>;
    }>;
    if (json.code !== 0) {
      throw new Error(json.msg || `API error: upload asset`);
    }
    const path = json.data?.succMap?.[fileName];
    if (!path) {
      throw new Error(`Upload failed: ${(json.data?.errFiles ?? []).join(', ') || 'no result'}`);
    }
    return path;
  }
}
