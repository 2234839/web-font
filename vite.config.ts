import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import {  } from "fs";

export default defineConfig({
  plugins: [solid()],
  server:{
    host:"0.0.0.0"
  }
})
