import { useCallback, useState } from 'react';
import * as Select from '@radix-ui/react-select';
import type { FlightRoute } from '../lib/workspace';

type Props = {
  id: string;
  label: string;
  routes: FlightRoute[];
  value: string;
  placeholder: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
};

export function RouteSelect({ id, label, routes, value, placeholder, disabled, onValueChange }: Props) {
  // Keep the menu inside the native dialog's top layer, outside its scrolling body.
  const [container, setContainer] = useState<HTMLDialogElement | null>(null);
  const attachTrigger = useCallback((node: HTMLButtonElement | null) => {
    setContainer(node?.closest('dialog') ?? null);
  }, []);
  const names = [...new Set(routes.map(route => route.name).filter(Boolean))];
  const missing = Boolean(value && !names.includes(value));

  return <Select.Root value={value} onValueChange={onValueChange} disabled={disabled || !names.length}>
    <Select.Trigger ref={attachTrigger} id={id} className="route-select-trigger" aria-label={label} title={value || placeholder}>
      <span className="route-select-value"><Select.Value placeholder={placeholder}>
        {value ? `${value}${missing ? '（需重新同步或选择）' : ''}` : undefined}
      </Select.Value></span>
      <Select.Icon className="route-select-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}>
      <Select.Content className="route-select-content" position="popper" sideOffset={6} collisionPadding={12}>
        <Select.ScrollUpButton className="route-select-scroll" aria-label="向上滚动">⌃</Select.ScrollUpButton>
        <Select.Viewport className="route-select-viewport">
          {names.map(name => <Select.Item key={name} value={name} className="route-select-item">
            <Select.ItemText>{name}</Select.ItemText>
            <Select.ItemIndicator className="route-select-check"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="route-select-scroll" aria-label="向下滚动">⌄</Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
