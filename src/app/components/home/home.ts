import { Component, signal, computed } from '@angular/core';
import { DatePipe } from '@angular/common';

type FileSystemFileHandle = any;
type FileSystemDirectoryHandle = any;

interface XlsxFile {
  name: string;
  size: number;
  lastModified: Date;
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
  scanning = signal(false);
  errorMsg = signal<string | null>(null);

  pickedFolderName = signal<string | null>(null);
  files = signal<XlsxFile[]>([]);
  totalFiles = computed(() => this.files().length);

  // seleção por nome do arquivo (único, já que não há subpastas)
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

  async pickDirectory() {
    this.errorMsg.set(null);
    this.files.set([]);
    this.pickedFolderName.set(null);
    this.clearSelection();

    try {
      const dirHandle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker();
      this.pickedFolderName.set((dirHandle as any).name ?? '(pasta selecionada)');
      this.scanning.set(true);

      const results: XlsxFile[] = [];
      // apenas a pasta raiz, sem recursão
      for await (const [name, handle] of (dirHandle as any).entries()) {
        if (handle.kind === 'file' && name.toLowerCase().endsWith('.xlsx')) {
          const file: File = await handle.getFile();
          results.push({
            name,
            size: file.size,
            lastModified: new Date(file.lastModified),
            handle,
          });
        }
      }

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

  humanSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

   // ===== Handlers de checkbox (chamados no template) =====
  onHeaderToggle(evt: Event) {
    const checked = (evt.target as HTMLInputElement).checked;
    checked ? this.selectAll() : this.clearSelection();
  }

  onRowToggle(evt: Event, name: string) {
    const checked = (evt.target as HTMLInputElement).checked;
    this.toggleOne(name, checked);
  }

private async copyFileToDir(
  srcHandle: any,                 // FileSystemFileHandle
  destDir: any,                   // FileSystemDirectoryHandle
  newName: string
) {
  // cria (ou abre) o arquivo de destino
  const destFileHandle = await destDir.getFileHandle(newName, { create: true });
  const writable = await destFileHandle.createWritable();

  try {
    const file = await srcHandle.getFile();
    await writable.write(file);
  } finally {
    await writable.close();
  }
}

  async sendFiles() {
    try {
      // 1) Coletar os selecionados
      const selectedNames = [...this._selected()];
      if (selectedNames.length === 0) {
        console.warn('Nenhum arquivo selecionado.');
        return;
      }

      // 2) Mapear nomes selecionados -> handles originais
      const selected = this.files().filter(f => selectedNames.includes(f.name));
      if (selected.length === 0) {
        console.warn('Seleção vazia (não casou com a lista atual).');
        return;
      }

      // 3) Usuário escolhe a pasta de destino (a pasta da nuvem já mapeada)
      const destDirHandle: any = await (window as any).showDirectoryPicker({
        id: 'dest-cloud-folder', // opcional; ajuda o navegador a lembrar
        // startIn: 'documents', // opcional
      });

      // 4) Solicitar permissão de escrita na pasta destino
      const perm = await destDirHandle.requestPermission?.({ mode: 'readwrite' });
      if (perm === 'denied') {
        console.error('Permissão negada para gravar na pasta de destino.');
        return;
      }

      // 5) Copiar cada arquivo
      //    (se quiser evitar sobrescrever, verifique com try { await destDirHandle.getFileHandle(name) } catch {} )
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
      // Dica: o cliente de sincronização (OneDrive/Drive/Dropbox) detecta as gravações e
      // inicia o upload automaticamente em segundo plano.

    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        console.warn('Envio cancelado pelo usuário.');
        return;
      }
      console.error('Erro no sendFiles():', err);
    }
  }

  discardFiles() { console.log("botão funcionando"); }
  
}