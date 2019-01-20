import { Neovim, Window, Buffer } from '@chemzqm/neovim'
import { Disposable, Emitter, Event } from 'vscode-languageserver-protocol'
import events from '../events'
import { ListItem, WorkspaceConfiguration } from '../types'
import workspace from '../workspace'
import { disposeAll } from '../util'
import { Highlights } from './worker'
const logger = require('../util/logger')('list-ui')

export type MouseEvent = 'mouseDown' | 'mouseDrag' | 'mouseUp' | 'doubleClick'

export default class ListUI {

  public window: Window
  private height: number
  private _bufnr = 0
  private srcId: number
  private currIndex = 0
  private highlights: Highlights[] = []
  private items: ListItem[] = []
  private disposables: Disposable[] = []
  private signOffset: number
  private selected: number[] = []
  private mouseDownLine: number
  private creating = false
  private _onDidChangeLine = new Emitter<number>()
  private _onDidOpen = new Emitter<number>()
  private _onDidClose = new Emitter<number>()
  private _onDidChange = new Emitter<void>()
  private _onDidLineChange = new Emitter<number>()
  private _onDoubleClick = new Emitter<void>()
  public readonly onDidChangeLine: Event<number> = this._onDidChangeLine.event
  public readonly onDidLineChange: Event<number> = this._onDidLineChange.event
  public readonly onDidOpen: Event<number> = this._onDidOpen.event
  public readonly onDidClose: Event<number> = this._onDidClose.event
  public readonly onDidChange: Event<void> = this._onDidChange.event
  public readonly onDidDoubleClick: Event<void> = this._onDoubleClick.event

  constructor(private nvim: Neovim, private config: WorkspaceConfiguration) {
    let signText = config.get<string>('selectedSignText', '*')
    nvim.command(`sign define CocSelected text=${signText} texthl=CocSelectedText linehl=CocSelectedLine`, true)
    this.signOffset = config.get<number>('signOffset')
    workspace.createNameSpace('list-ui').then(srcId => {
      this.srcId = srcId || 998
    })

    events.on('BufUnload', async bufnr => {
      if (bufnr == this.bufnr) {
        this._bufnr = 0
        this.window = null
        this._onDidClose.fire(bufnr)
      }
    }, null, this.disposables)

    let timer: NodeJS.Timeout
    events.on('CursorMoved', async bufnr => {
      if (timer) clearTimeout(timer)
      if (bufnr != this.bufnr) return
      let lnum = await nvim.call('line', '.')
      if (this.currIndex + 1 == lnum) return
      this.currIndex = lnum - 1
      timer = setTimeout(() => {
        if (workspace.bufnr == this.bufnr) {
          this._onDidChangeLine.fire(lnum)
        }
      }, 100)
    }, null, this.disposables)
  }

  public set index(n: number) {
    if (n == 0 || n >= this.items.length) return
    this.currIndex = n
    if (this.window) {
      this.setCursor(n + 1, 0, true)
      this.nvim.command('redraw', true)
    }
  }

  public get index(): number {
    return this.currIndex
  }

  public getItem(delta: number): ListItem {
    let { currIndex } = this
    return this.items[currIndex + delta]
  }

  public get item(): Promise<ListItem> {
    let { nvim } = this
    return nvim.call('line', '.').then(n => {
      if (n > this.items.length) {
        logger.error('Invalid line number')
        return null
      }
      this.currIndex = n - 1
      return this.items[this.currIndex]
    })
  }

  public async echoMessage(item: ListItem): Promise<void> {
    if (this.bufnr) return
    let { items } = this
    let idx = items.indexOf(item)
    let msg = `[${idx + 1}/${items.length}] ${item.label || ''}`
    await this.nvim.call('coc#util#echo_lines', [[msg]])
  }

  public async getItems(): Promise<ListItem[]> {
    if (this.length == 0) return []
    let { selectedItems } = this
    if (selectedItems.length) return selectedItems
    let item = await this.item
    return item == null ? [] : [item]
  }

  public async onMouse(event: MouseEvent): Promise<void> {
    let { nvim, window } = this
    let winid = await nvim.getVvar('mouse_winid')
    if (!window || winid != window.id) return
    let lnum = await nvim.getVvar('mouse_lnum') as number
    if (event == 'doubleClick') {
      await this.setCursor(lnum, 0)
      this._onDoubleClick.fire()
    } else if (event == 'mouseDown') {
      this.mouseDownLine = lnum
    } else if (event == 'mouseDrag') {
      if (this.mouseDownLine) {
        await this.selectLines(this.mouseDownLine, lnum)
      }
    } else if (event == 'mouseUp') {
      if (this.mouseDownLine && lnum == this.mouseDownLine) {
        nvim.pauseNotification()
        this.clearSelection()
        this.setCursor(this.mouseDownLine, 0, true)
        nvim.command('redraw', true)
        await nvim.resumeNotification()
      } else if (this.mouseDownLine) {
        await this.selectLines(this.mouseDownLine, lnum)
      }
    }
  }

  public reset(): void {
    this.items = []
    this.mouseDownLine = null
    this.selected = []
    this._bufnr = 0
    this.window = null
  }

  public hide(): void {
    let { bufnr, nvim } = this
    if (bufnr) {
      this._bufnr = 0
      nvim.command(`silent! bd! ${bufnr}`, true)
    }
  }

  public async resume(name: string, position: string): Promise<void> {
    let { items, selected, nvim, signOffset } = this
    await this.drawItems(items, name, position, true)
    if (selected.length && this.bufnr) {
      nvim.pauseNotification()
      for (let lnum of selected) {
        nvim.command(`sign place ${signOffset + lnum} line=${lnum} name=CocSelected buffer=${this.bufnr}`, true)
      }
      await nvim.resumeNotification()
    }
  }

  public async toggleSelection(): Promise<void> {
    let { nvim, selected, signOffset, bufnr } = this
    if (workspace.bufnr != bufnr) return
    let lnum = await nvim.call('line', '.')
    let idx = selected.indexOf(lnum)
    nvim.pauseNotification()
    if (idx !== -1) {
      selected.splice(idx, 1)
      nvim.command(`sign unplace ${signOffset + lnum} buffer=${bufnr}`, true)
    } else {
      selected.push(lnum)
      nvim.command(`sign place ${signOffset + lnum} line=${lnum} name=CocSelected buffer=${bufnr}`, true)
    }
    this.setCursor(lnum + 1, 0, true)
    nvim.command('redraw', true)
    await nvim.resumeNotification()
  }

  public async selectLines(start: number, end: number): Promise<void> {
    let { nvim, signOffset, bufnr, length } = this
    this.clearSelection()
    let { selected } = this
    nvim.pauseNotification()
    let reverse = start > end
    if (reverse) [start, end] = [end, start]
    for (let i = start; i <= end; i++) {
      if (i > length) break
      selected.push(i)
      nvim.command(`sign place ${signOffset + i} line=${i} name=CocSelected buffer=${bufnr}`, true)
    }
    this.setCursor(end, 0, true)
    nvim.command('redraw', true)
    await nvim.resumeNotification()
  }

  public clearSelection(): void {
    let { selected, nvim, signOffset, bufnr } = this
    if (!bufnr) return
    if (selected.length) {
      let signIds: number[] = []
      for (let lnum of selected) {
        signIds.push(signOffset + lnum)
      }
      nvim.call('coc#util#unplace_signs', [bufnr, signIds], true)
      this.selected = []
    }
  }

  public get shown(): boolean {
    return this._bufnr != 0
  }

  public get bufnr(): number {
    return this._bufnr
  }

  public get ready(): Promise<void> {
    if (this._bufnr) return Promise.resolve()
    if (this.creating) {
      return new Promise<void>(resolve => {
        let disposable = this.onDidOpen(() => {
          disposable.dispose()
          resolve()
        })
      })
    }
  }

  public async drawItems(items: ListItem[], name: string, position = 'bottom', resume = false): Promise<void> {
    let { bufnr, config, nvim } = this
    let maxHeight = config.get<number>('maxHeight', 12)
    let height = Math.max(1, Math.min(items.length, maxHeight))
    let limitLines = config.get<number>('limitLines', 3000)
    let curr = this.items[this.index]
    this.items = items
    if (bufnr == 0 && !this.creating) {
      this.creating = true
      let cmd = 'keepalt ' + (position == 'top' ? '' : 'botright') + ` ${height}sp list://${name || 'anonymous'}`
      await nvim.command(cmd)
      this._bufnr = await nvim.call('bufnr', '%')
      this.window = await nvim.window
      this.creating = false
      this._onDidOpen.fire(this.bufnr)
    } else {
      await this.ready
    }
    if (this.items.length > limitLines) {
      items = this.items.slice(0, limitLines)
    } else {
      items = this.items
    }
    let lines = items.map(item => item.label)
    await this.setLines(lines, false, resume ? this.currIndex : 0)
    this.clearSelection()
    let item = this.items[this.index] || { label: '' }
    if (!curr || curr.label != item.label) {
      this._onDidLineChange.fire(this.index + 1)
    }
  }

  public async appendItems(items: ListItem[]): Promise<void> {
    let { config } = this
    let limitLines = config.get<number>('limitLines', 3000)
    let curr = this.items.length
    if (curr >= limitLines) {
      this._onDidChange.fire()
      return
    }
    let len = this.length
    this.items.push(...items)
    if (this.creating) return
    if (this.items.length > limitLines) {
      items = items.slice(0, limitLines - curr)
    }
    await this.setLines(items.map(item => item.label), len > 0, this.currIndex)
  }

  private async setLines(lines: string[], append = false, index: number): Promise<void> {
    let { nvim, bufnr, window, config } = this
    if (!bufnr) return
    let resize = config.get<boolean>('autoResize', true)
    let buf = nvim.createBuffer(bufnr)
    nvim.pauseNotification()
    if (resize && window) {
      let maxHeight = config.get<number>('maxHeight', 12)
      let height = this.height = Math.max(1, Math.min(this.items.length, maxHeight))
      window.notify(`nvim_win_set_height`, [window, height])
    }
    nvim.command('setl modifiable', true)
    buf.setLines(lines, { start: append ? -1 : 0, end: -1, strictIndexing: false }, true)
    nvim.command('setl nomodifiable', true)
    this.doHighlight()
    if (!append) nvim.call('cursor', [index + 1, 0], true)
    this._onDidChange.fire()
    nvim.command('redraw', true)
    await nvim.resumeNotification()
  }

  public async restoreWindow(): Promise<void> {
    let { window, height } = this
    if (window && height) {
      await window.request(`nvim_win_set_height`, [window, height])
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }

  public get length(): number {
    return this.items.length
  }

  private get selectedItems(): ListItem[] {
    let { selected, items } = this
    let res: ListItem[] = []
    for (let i of selected) {
      if (items[i]) res.push(items[i])
    }
    return res
  }

  private get buffer(): Buffer {
    return this._bufnr ? workspace.nvim.createBuffer(this._bufnr) : null
  }

  private doHighlight(): void {
    if (workspace.isVim) return
    let { nvim } = workspace
    let { highlights, buffer, srcId, length } = this
    if (nvim.hasFunction('nvim_create_namespace')) {
      buffer.clearNamespace(srcId)
    } else {
      buffer.clearHighlight({ srcId })
    }
    if (!highlights.length) return
    for (let highlight of highlights) {
      let { lnum, spans } = highlight
      if (lnum >= length) continue
      for (let span of spans) {
        buffer.addHighlight({
          hlGroup: 'Search',
          srcId,
          line: lnum,
          colStart: span[0],
          colEnd: span[1]
        })
      }
    }
  }

  public setCursor(lnum: number, col: number, notify = false): Promise<void> {
    let { window, bufnr } = this
    if (!bufnr || !window) return Promise.resolve()
    return Promise.resolve(window[notify ? 'notify' : 'request']('nvim_win_set_cursor', [window, [lnum, col]]))
  }

  public addHighlights(highlights: Highlights[], append = false) {
    if (!append) {
      this.highlights = highlights
    } else {
      this.highlights.push(...highlights)
    }
  }
}
