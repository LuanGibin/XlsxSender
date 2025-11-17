import { Component, signal, computed } from '@angular/core';
import { DatePipe } from '@angular/common';
import JSZip from 'jszip';

type FileSystemFileHandle = any;
type FileSystemDirectoryHandle = any;

type FileStatus = 'sent' | 'discarded';

interface XlsxFile {
  name: string;
  size: number;
  lastModified: Date;
  lastSavedBy?: string;
  handle: FileSystemFileHandle;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  // ===== Estado UI =====
  scanning = signal(false);
  errorMsg = signal<string | null>(null);

  // ===== Dados base =====
  pickedFolderName = signal<string | null>(null);
  files = signal<XlsxFile[]>([]);
  totalFiles = computed(() => this.files().length);

  // ===== Seleção por nome =====
  private _selected = signal<Set<string>>(new Set());
  selectedCount = computed(() => this._selected().size);
  isSelected(name: string) { return this._selected().has(name); }

  toggleOne(name: string, checked: boolean) {
    const next = new Set(this._selected());
    checked ? next.add(name) : next.delete(name);
    this._selected.set(next);
  }

  selectAll() {
    const next = new Set<string>();
    for (const f of this.files()) next.add(f.name);
    this._selected.set(next);
  }

  clearSelection() { this._selected.set(new Set()); }

  // ===== Pasta de origem e status JSON =====
  private originDirHandle: FileSystemDirectoryHandle | null = null;
  private readonly STATUS_FILENAME = 'xlsx-sender-status.json';

  private makeStatusKey(name: string, size: number, lastModified: number): string {
    return `${name}|${size}|${lastModified}`;
  }

  private async loadStatusMapFromFolder(
    dir: FileSystemDirectoryHandle
  ): Promise<Record<string, FileStatus>> {
    try {
      const fileHandle = await (dir as any).getFileHandle(this.STATUS_FILENAME, { create: false });
      const file = await fileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text) as Record<string, FileStatus>;
    } catch {
      // Se o arquivo não existir ou der erro, começa com mapa vazio
      return {};
    }
  }

  private async saveStatusMapToFolder(
    dir: FileSystemDirectoryHandle,
    map: Record<string, FileStatus>
  ): Promise<void> {
    const fileHandle = await (dir as any).getFileHandle(this.STATUS_FILENAME, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(JSON.stringify(map, null, 2)); // bonitinho, indentado
    } finally {
      await writable.close();
    }
  }

  // ===== Metadados do .xlsx (lastSavedBy) =====
  private async getLastSavedByFromXlsx(file: File): Promise<string | undefined> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);

      const coreEntry = zip.file('docProps/core.xml');
      if (!coreEntry) return undefined;

      const coreXml = await coreEntry.async('text');

      const match = coreXml.match(/<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/);
      if (match && match[1]) {
        return match[1].trim();
      }

      return undefined;
    } catch (e) {
      console.warn('Falha ao ler LastSavedBy de', file.name, e);
      return undefined;
    }
  }

  // ===== Escolher pasta de origem e montar lista =====
  async pickDirectory() {
    this.errorMsg.set(null);
    this.files.set([]);
    this.pickedFolderName.set(null);
    this.clearSelection();

    try {
      const dirHandle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker();
      this.originDirHandle = dirHandle; // guardar para usar em send/discard
      this.pickedFolderName.set((dirHandle as any).name ?? '(pasta selecionada)');
      this.scanning.set(true);

      const statusMap = await this.loadStatusMapFromFolder(dirHandle);
      const results: XlsxFile[] = [];

      // apenas a pasta raiz, sem subpastas
      for await (const [name, handle] of (dirHandle as any).entries()) {
        if (handle.kind === 'file' && name.toLowerCase().endsWith('.xlsx')) {
          const file: File = await handle.getFile();

          const key = this.makeStatusKey(name, file.size, file.lastModified);
          // Se já foi enviado ou descartado, não entra na lista
          if (statusMap[key] === 'sent' || statusMap[key] === 'discarded') {
            continue;
          }

          const lastSavedBy = await this.getLastSavedByFromXlsx(file);

          results.push({
            name,
            size: file.size,
            lastModified: new Date(file.lastModified),
            lastSavedBy,
            handle,
          });
        }
      }

      // ordenar por data (mais recente primeiro)
      results.sort((b, a) => a.lastModified.getTime() - b.lastModified.getTime());
      this.files.set(results);
      this.clearSelection();
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.errorMsg.set(err?.message ?? 'Falha ao acessar a pasta.');
      }
    } finally {
      this.scanning.set(false);
    }
  }

  // ===== Utils =====
  humanSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  // ===== Handlers de checkbox (template) =====
  onHeaderToggle(evt: Event) {
    const checked = (evt.target as HTMLInputElement).checked;
    checked ? this.selectAll() : this.clearSelection();
  }

  onRowToggle(evt: Event, name: string) {
    const checked = (evt.target as HTMLInputElement).checked;
    this.toggleOne(name, checked);
  }

  // ===== Cópia de arquivo para pasta destino =====
  private async copyFileToDir(
    srcHandle: any,               // FileSystemFileHandle
    destDir: any,                 // FileSystemDirectoryHandle
    newName: string
  ) {
    const destFileHandle = await destDir.getFileHandle(newName, { create: true });
    const writable = await destFileHandle.createWritable();

    try {
      const file = await srcHandle.getFile();
      await writable.write(file);
    } finally {
      await writable.close();
    }
  }

  // ===== Enviar arquivos selecionados (marca como 'sent' no JSON da pasta de origem) =====
  async sendFiles() {
    try {
      const selectedNames = [...this._selected()];
      if (selectedNames.length === 0) {
        console.warn('Nenhum arquivo selecionado.');
        return;
      }

      const selected = this.files().filter(f => selectedNames.includes(f.name));
      if (selected.length === 0) {
        console.warn('Seleção vazia (não casou com a lista atual).');
        return;
      }

      // pasta destino (nuvem mapeada)
      const destDirHandle: any = await (window as any).showDirectoryPicker({
        id: 'dest-cloud-folder',
      });

      const perm = await destDirHandle.requestPermission?.({ mode: 'readwrite' });
      if (perm === 'denied') {
        console.error('Permissão negada para gravar na pasta de destino.');
        return;
      }

      let ok = 0, fail = 0;
      for (const item of selected) {
        try {
          await this.copyFileToDir(item.handle, destDirHandle, item.name);
          ok++;
          console.log(`Copiado: ${item.name}`);
        } catch (e) {
          fail++;
          console.error(`Falhou ao copiar: ${item.name}`, e);
        }
      }

      console.log(`Concluído. Sucesso: ${ok}, Falhas: ${fail}.`);
      console.log('botão funcionando');

      // Atualizar status JSON na pasta de origem
      if (!this.originDirHandle) {
        console.warn('originDirHandle não definido; não foi possível salvar status na pasta de origem.');
      } else {
        const map = await this.loadStatusMapFromFolder(this.originDirHandle);
        for (const item of selected) {
          const file = await item.handle.getFile();
          const key = this.makeStatusKey(item.name, file.size, file.lastModified);
          map[key] = 'sent';
        }
        await this.saveStatusMapToFolder(this.originDirHandle, map);
      }

      // Remover da lista e limpar seleção
      this.files.update(list => list.filter(f => !selectedNames.includes(f.name)));
      this.clearSelection();

    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        console.warn('Envio cancelado pelo usuário.');
        return;
      }
      console.error('Erro no sendFiles():', err);
    }
  }

  // ===== Descartar arquivos selecionados (marca como 'discarded' no JSON da pasta de origem) =====
  async discardFiles() {
    try {
      const selectedNames = [...this._selected()];
      if (selectedNames.length === 0) {
        console.warn('Nenhum arquivo selecionado para descartar.');
        return;
      }

      const selected = this.files().filter(f => selectedNames.includes(f.name));
      if (selected.length === 0) {
        console.warn('Seleção vazia (não casou com a lista atual).');
        return;
      }

      console.log('botão funcionando');

      if (!this.originDirHandle) {
        console.warn('originDirHandle não definido; não foi possível salvar status na pasta de origem.');
      } else {
        const map = await this.loadStatusMapFromFolder(this.originDirHandle);
        for (const item of selected) {
          const file = await item.handle.getFile();
          const key = this.makeStatusKey(item.name, file.size, file.lastModified);
          map[key] = 'discarded';
        }
        await this.saveStatusMapToFolder(this.originDirHandle, map);
      }

      // Remover da tabela e limpar seleção
      this.files.update(list => list.filter(f => !selectedNames.includes(f.name)));
      this.clearSelection();
    } catch (err) {
      console.error('Erro no discardFiles():', err);
    }
  }
}
