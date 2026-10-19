import { createContext, useContext } from 'react'

// The signed-in shell. Lives outside App.jsx so the account page can
// read it without a circular import (App renders that page).
export const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)
