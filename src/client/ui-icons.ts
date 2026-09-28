import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

// DSH 0.1.7 names icons by weight instead of size. Keep Mnemon's public
// aliases usable with both generations of the host-provided UI package.
function compatibleIcon(legacy: string, current: string): ComponentType<IconProps> {
  const icons = primitives as unknown as Record<string, ComponentType<IconProps> | undefined>
  const component = icons[legacy] ?? icons[current]
  if (component === undefined) throw new Error(`DSH UI icon is unavailable: ${current}`)
  return component
}

export const IconChevronLeftOutline14 = compatibleIcon('IconChevronLeftOutline14', 'IconChevronLeftOutlineRegular')
export const IconDataOutline16 = compatibleIcon('IconDataOutline16', 'IconDataOutlineRegular')
