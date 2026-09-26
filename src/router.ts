// Generouted, changes to this file will be overridden
/* eslint-disable */

import { components, hooks, utils } from '@generouted/react-router/client'

export type Path =
  | `/`
  | `/assistant`
  | `/entry/:kind/:id`
  | `/fasting`
  | `/library`
  | `/nutrients`
  | `/settings`

export type Params = {
  '/entry/:kind/:id': { kind: string; id: string }
}

export type ModalPath = never

export const { Link, Navigate } = components<Path, Params>()
export const { useModals, useNavigate, useParams } = hooks<Path, Params, ModalPath>()
export const { redirect } = utils<Path, Params>()
