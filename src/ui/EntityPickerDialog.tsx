import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useModalDialog } from './useModalDialog'

export interface EntityPickerItem {
  id: string
  label: string
  description: string
}

export function EntityPickerDialog({ title, items, onSelect, onClose }: {
  title: string
  items: EntityPickerItem[]
  onSelect(id: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(false)
  const dialogRef = useModalDialog(onClose, searchRef)
  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return normalizedQuery
      ? items.filter((item) => `${item.label} ${item.description}`.toLocaleLowerCase().includes(normalizedQuery))
      : items
  }, [items, query])

  useEffect(() => { setActiveIndex(0) }, [query])

  const choose = (id: string) => {
    if (selectedRef.current) return
    selectedRef.current = true
    onSelect(id)
  }
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(filteredItems.length - 1, 0)))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    }
    if (event.key === 'Enter' && filteredItems[activeIndex]) {
      event.preventDefault()
      choose(filteredItems[activeIndex].id)
    }
  }

  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="entity-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="entity-picker-title"><header><div><p>选择一个项目</p><h2 id="entity-picker-title">{title}</h2></div><button type="button" className="icon-button" aria-label={`关闭${title}`} data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <label className="sr-only" htmlFor="entity-picker-search">搜索</label><input ref={searchRef} id="entity-picker-search" aria-label="搜索" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} placeholder="搜索" />
    {filteredItems.length ? <div className="entity-picker-list" role="listbox" aria-label={title} aria-activedescendant={`entity-picker-option-${filteredItems[activeIndex]?.id}`}>
      {filteredItems.map((item, index) => <button type="button" id={`entity-picker-option-${item.id}`} key={item.id} role="option" aria-label={item.label} aria-selected={index === activeIndex} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}
    </div> : <p className="entity-picker-empty">没有可添加的项目。</p>}
  </section></div>
}
