import yo from 'yo-yo'
import {makeSafe, highlight} from '../../../lib/strings'

// exported api
// =

export default function render (pageInfo, currentUserSession, highlightNonce) {
  return yo`
    <div class="search-result page">
      <div class="thumb">
        <img src=${pageInfo.thumbUrl} alt="">
      </div>
      <div class="details">
        <a class="link title" href=${pageInfo.url} title=${getTitle(pageInfo)}>${renderTitle(pageInfo, highlightNonce)}</a>
        <div class="hostname">${getHostname(pageInfo.url)}</div>
        ${renderDescription(pageInfo, highlightNonce)}
      </div>
    </div>`
}

// rendering
// =

function renderTitle (pageInfo, highlightNonce) {
  var el = yo`<span></span>`
  el.innerHTML = highlight(makeSafe(getTitle(pageInfo)), highlightNonce)
  return el
}

function renderDescription (pageInfo, highlightNonce) {
  if (pageInfo.description) {
    var el = yo`<div class="description"></div>`
    el.innerHTML = highlight(makeSafe(pageInfo.description), highlightNonce)
    return el
  }
  return ''
}

function getTitle (pageInfo) {
  if (pageInfo.title) return pageInfo.title
  return 'Anonymous'
}

function getHostname (url) {
  return (new URL(url)).hostname
}
