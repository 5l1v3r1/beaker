/* globals customElements */
import { LitElement, html, css } from '../vendor/lit-element/lit-element'
import { repeat } from '../vendor/lit-element/lit-html/directives/repeat'
import * as bg from './bg-process-rpc'
import commonCSS from './common.css'
import inputsCSS from './inputs.css'
import buttonsCSS from './buttons2.css'
import spinnerCSS from './spinner.css'
import _groupBy from 'lodash.groupby'

class CreateDriveModal extends LitElement {
  static get properties () {
    return {
      title: {type: String},
      description: {type: String},
      type: {type: String},
      theme: {type: String},
      errors: {type: Object}
    }
  }

  static get styles () {
    return [commonCSS, inputsCSS, buttonsCSS, spinnerCSS, css`
    .wrapper {
      padding: 0;
    }
    
    h1.title {
      padding: 14px 20px;
      margin: 0;
      border-color: #bbb;
    }

    h1.title select {
      position: relative;
      top: -1px;
      left: 1px;
    }
    
    form {
      padding: 14px 20px;
      margin: 0;
    }

    input {
      font-size: 14px;
      height: 34px;
      padding: 0 10px;
      border-color: #bbb;
    }
    
    hr {
      border: 0;
      border-top: 1px solid #ddd;
      margin: 20px 0;
    }

    .themes {
      background: #eef;
      border: 1px solid #ccd;
      padding: 10px;
      overflow-y: auto;
      max-height: 180px;
      margin: 4px 0 0;
    }

    .themes-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-gap: 10px;
    }

    .theme img,
    .theme .img-for-none {
      width: 100%;
      height: 80px;
      object-fit: cover;
      margin-bottom: 10px;
    }

    .theme .img-for-none {
      background: #fff;
    }

    .theme .title {
      text-align: center;
    }

    .theme.selected .title span {
      background: #334;
      color: #fff;
      border-radius: 4px;
      padding: 0 6px;
    }

    .theme.selected img,
    .theme.selected .img-for-none {
      outline: 1px solid #334;
    }

    .form-actions {
      display: flex;
      justify-content: space-between;
    }
    
    .form-actions button {
      padding: 6px 12px;
      font-size: 12px;
    }
    `]
  }

  constructor () {
    super()
    this.cbs = undefined
    this.title = ''
    this.description = ''
    this.type = undefined
    this.links = undefined
    this.author = undefined
    this.theme = undefined
    this.themes = []
    this.errors = {}

    // export interface
    window.createDriveClickSubmit = () => this.shadowRoot.querySelector('button[type="submit"]').click()
    window.createDriveClickCancel = () => this.shadowRoot.querySelector('.cancel').click()
  }

  async init (params, cbs) {
    this.cbs = cbs
    this.title = params.title || ''
    this.description = params.description || ''
    this.type = params.type || undefined
    this.links = params.links
    this.author = this.author || (await bg.users.getCurrent()).url
    this.themes = await this.readThemes()
    await this.requestUpdate()
  }

  async readThemes () {
    var drives = await bg.drives.list()
    return drives.map(drive => drive.info).filter(info => info.type === 'theme')
  }

  updated () {
    this.adjustHeight()
  }

  adjustHeight () {
    var height = this.shadowRoot.querySelector('div').clientHeight
    bg.modals.resizeSelf({height})
  }

  // rendering
  // =

  render () {
    const typeopt = (id, label) => html`<option value=${id} ?selected=${id === this.type}>${label}</option>`
    return html`
      <link rel="stylesheet" href="beaker://assets/font-awesome.css">
      <div class="wrapper">
        <h1 class="title">
          Create new 
          <select name="type" @change=${this.onChangeType}>
            ${typeopt('undefined', 'Files drive')}
            ${typeopt('website', 'Website')}
            ${typeopt('module', 'Module')}
            ${typeopt('theme', 'Theme')}
          </select>
        </h1>

        <form @submit=${this.onSubmit}>
          <label for="title">Title</label>
          <input autofocus name="title" tabindex="2" value=${this.title || ''} @change=${this.onChangeTitle} class="${this.errors.title ? 'has-error' : ''}" />
          ${this.errors.title ? html`<div class="error">${this.errors.title}</div>` : ''}

          <label for="desc">Description</label>
          <input name="desc" tabindex="3" @change=${this.onChangeDescription} value=${this.description || ''}>

          <label for="desc">Theme</label>
          <div class="themes">
            <div class="themes-grid">
              <div 
                class="theme ${this.theme === undefined ? 'selected' : ''}"
                @click=${e => this.onClickTheme(e, undefined)}
              >
                <div class="img-for-none"></div>
                <div class="title"><span>None</span></div>
              </div>
              ${repeat(this.themes, t => this.renderTheme(t))}
            </div>
          </div>
          
          <hr>

          <div class="form-actions">
            <button type="button" @click=${this.onClickCancel} class="cancel" tabindex="5">Cancel</button>
            <button type="submit" class="primary" tabindex="4">Create</button>
          </div>
        </form>
      </div>
    `
  }

  renderTheme (theme) {
    return html`
      <div 
        class="theme ${this.theme === theme.url ? 'selected' : ''}"
        @click=${e => this.onClickTheme(e, theme.url)}
      >
        <img src="${theme.url}/thumb" @error=${this.onThemeImgError}>
        <div class="title"><span>${theme.title}</span></div>
      </div>
    `
  }

  // event handlers
  // =

  onChangeTitle (e) {
    this.title = e.target.value.trim()
  }

  onChangeDescription (e) {
    this.description = e.target.value.trim()
  }

  onChangeType (e) {
    this.type = e.target.value.trim()
  }

  onClickTheme (e, themeUrl) {
    this.theme = themeUrl
  }

  onThemeImgError (e) {
    e.currentTarget.setAttribute('src', 'beaker://assets/default-theme-thumb')
  }

  onClickCancel (e) {
    e.preventDefault()
    this.cbs.reject(new Error('Canceled'))
  }

  async onSubmit (e) {
    e.preventDefault()

    if (!this.title) {
      this.errors = {title: 'Required'}
      return
    }

    this.shadowRoot.querySelector('button[type="submit"]').innerHTML = `<div class="spinner"></div>`

    try {
      var url = await bg.hyperdrive.createDrive({
        title: this.title,
        description: this.description,
        type: this.type !== 'undefined' ? this.type : undefined,
        author: this.author,
        links: this.links,
        prompt: false
      })
      if (this.theme) {
        try {
          await bg.hyperdrive.mount(url, '/theme', this.theme)
        } catch (e) {
          console.error('Failed to set theme', e)
        }
      }
      this.cbs.resolve({url})
    } catch (e) {
      this.cbs.reject(e.message || e.toString())
    }
  }
}

customElements.define('create-drive-modal', CreateDriveModal)