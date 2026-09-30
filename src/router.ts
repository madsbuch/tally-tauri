// Generouted, changes to this file will be overridden
/* eslint-disable */

import { components, hooks, utils } from '@generouted/react-router/client'

export type Path =
  | `/`
  | `/assistant`
  | `/assistant/:chatId`
  | `/assistant/library`
  | `/entry/:kind/:id`
  | `/fasting`
  | `/nutrients`
  | `/settings`

export type Params = {
  '/assistant/:chatId': { chatId: string }
  '/entry/:kind/:id': { kind: string; id: string }
}

export type ModalPath = never

export const { Link, Navigate } = components<Path, Params>()
export const { useModals, useNavigate, useParams } = hooks<Path, Params, ModalPath>()
export const { redirect } = utils<Path, Params>()
