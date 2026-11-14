'use strict';
(() => {
  // Microsoft Fluent UI System Icons 1.1.345 (MIT), pinned source and hashes:
  // ../assets/ui-icons/manifest.json. Regular and Filled are separate artwork.
  // The AI mark extracts the primary four-point star from each upstream style.
  const icons = {
    "grid": ["ic_fluent_grid_20_regular.svg", "ic_fluent_grid_20_filled.svg"],
    "list": ["ic_fluent_text_bullet_list_20_regular.svg", "ic_fluent_text_bullet_list_20_filled.svg"],
    "screenshot": ["ic_fluent_screenshot_20_regular.svg", "ic_fluent_screenshot_20_filled.svg"],
    "undo": ["ic_fluent_arrow_undo_20_regular.svg", "ic_fluent_arrow_undo_20_filled.svg"],
    "redo": ["ic_fluent_arrow_redo_20_regular.svg", "ic_fluent_arrow_redo_20_filled.svg"],
    "rectangle": ["ic_fluent_rectangle_landscape_20_regular.svg", "ic_fluent_rectangle_landscape_20_filled.svg"],
    "ellipse": ["ic_fluent_circle_20_regular.svg", "ic_fluent_circle_20_filled.svg"],
    "arrow": ["ic_fluent_arrow_up_right_20_regular.svg", "ic_fluent_arrow_up_right_20_filled.svg"],
    "text": ["ic_fluent_text_field_20_regular.svg", "ic_fluent_text_field_20_filled.svg"],
    "text-bold": ["ic_fluent_text_bold_20_regular.svg", "ic_fluent_text_bold_20_filled.svg"],
    "text-italic": ["ic_fluent_text_italic_20_regular.svg", "ic_fluent_text_italic_20_filled.svg"],
    "text-underline": ["ic_fluent_text_underline_20_regular.svg", "ic_fluent_text_underline_20_filled.svg"],
    "omega": ["ic_fluent_omega_20_regular.svg", "ic_fluent_omega_20_filled.svg"],
    "pen": ["ic_fluent_pen_20_regular.svg", "ic_fluent_pen_20_filled.svg"],
    "crop": ["ic_fluent_crop_20_regular.svg", "ic_fluent_crop_20_filled.svg"],
    "chat": ["ic_fluent_chat_20_regular.svg", "ic_fluent_chat_20_filled.svg"],
    "send": ["ic_fluent_send_20_regular.svg", "ic_fluent_send_20_filled.svg"],
    "sparkle": [
      "inmoment_sparkle_20_regular.svg",
      "inmoment_sparkle_20_filled.svg"
    ],
    "folder": [
      "ic_fluent_folder_20_regular.svg",
      "ic_fluent_folder_20_filled.svg"
    ],
    "folder-plus": [
      "ic_fluent_folder_add_20_regular.svg",
      "ic_fluent_folder_add_20_filled.svg"
    ],
    "folder-in": [
      "ic_fluent_folder_arrow_right_20_regular.svg",
      "ic_fluent_folder_arrow_right_20_filled.svg"
    ],
    "edit": [
      "ic_fluent_edit_20_regular.svg",
      "ic_fluent_edit_20_filled.svg"
    ],
    "image": [
      "ic_fluent_image_20_regular.svg",
      "ic_fluent_image_20_filled.svg"
    ],
    "play": [
      "ic_fluent_play_20_regular.svg",
      "ic_fluent_play_20_filled.svg"
    ],
    "pause": [
      "ic_fluent_pause_20_regular.svg",
      "ic_fluent_pause_20_filled.svg"
    ],
    "trash": [
      "ic_fluent_delete_20_regular.svg",
      "ic_fluent_delete_20_filled.svg"
    ],
    "search": [
      "ic_fluent_search_20_regular.svg",
      "ic_fluent_search_20_filled.svg"
    ],
    "record": [
      "ic_fluent_mic_20_regular.svg",
      "ic_fluent_mic_20_filled.svg"
    ],
    "help": [
      "ic_fluent_question_circle_20_regular.svg",
      "ic_fluent_question_circle_20_filled.svg"
    ],
    "external": [
      "ic_fluent_open_20_regular.svg",
      "ic_fluent_open_20_filled.svg"
    ],
    "transcript": [
      "ic_fluent_document_text_20_regular.svg",
      "ic_fluent_document_text_20_filled.svg"
    ],
    "volume": [
      "ic_fluent_speaker_2_20_regular.svg",
      "ic_fluent_speaker_2_20_filled.svg"
    ],
    "volume-off": [
      "ic_fluent_speaker_mute_20_regular.svg",
      "ic_fluent_speaker_mute_20_filled.svg"
    ],
    "calendar": [
      "ic_fluent_calendar_ltr_20_regular.svg",
      "ic_fluent_calendar_ltr_20_filled.svg"
    ],
    "settings": [
      "ic_fluent_settings_20_regular.svg",
      "ic_fluent_settings_20_filled.svg"
    ],
    "panel": [
      "ic_fluent_panel_left_20_regular.svg",
      "ic_fluent_panel_left_20_filled.svg"
    ],
    "clock": [
      "ic_fluent_clock_20_regular.svg",
      "ic_fluent_clock_20_filled.svg"
    ],
    "cloud": [
      "ic_fluent_branch_fork_20_regular.svg",
      "ic_fluent_branch_fork_20_filled.svg"
    ],
    "more": [
      "ic_fluent_more_horizontal_20_regular.svg",
      "ic_fluent_more_horizontal_20_filled.svg"
    ],
    "back": [
      "ic_fluent_arrow_left_20_regular.svg",
      "ic_fluent_arrow_left_20_filled.svg"
    ],
    "close": [
      "ic_fluent_dismiss_20_regular.svg",
      "ic_fluent_dismiss_20_filled.svg"
    ],
    "add": [
      "ic_fluent_add_20_regular.svg",
      "ic_fluent_add_20_filled.svg"
    ],
    "minus": [
      "ic_fluent_subtract_20_regular.svg",
      "ic_fluent_subtract_20_filled.svg"
    ],
    "expand": [
      "ic_fluent_full_screen_maximize_20_regular.svg",
      "ic_fluent_full_screen_maximize_20_filled.svg"
    ],
    "chevron": [
      "ic_fluent_chevron_down_20_regular.svg",
      "ic_fluent_chevron_down_20_filled.svg"
    ],
    "group-fold": [
      "inmoment_group_fold_20_regular.svg",
      "inmoment_group_fold_20_filled.svg"
    ],
    "check": [
      "ic_fluent_checkmark_20_regular.svg",
      "ic_fluent_checkmark_20_filled.svg"
    ],
    "refresh": [
      "ic_fluent_arrow_clockwise_20_regular.svg",
      "ic_fluent_arrow_clockwise_20_filled.svg"
    ],
    "focus": [
      "ic_fluent_scan_object_20_regular.svg",
      "ic_fluent_scan_object_20_filled.svg"
    ],
    "merge": [
      "ic_fluent_merge_20_regular.svg",
      "ic_fluent_merge_20_filled.svg"
    ],
    "filter": [
      "ic_fluent_filter_20_regular.svg",
      "ic_fluent_filter_20_filled.svg"
    ],
    "checklist": [
      "ic_fluent_text_bullet_list_square_20_regular.svg",
      "ic_fluent_text_bullet_list_square_20_filled.svg"
    ],
    "sort": [
      "ic_fluent_arrow_sort_20_regular.svg",
      "ic_fluent_arrow_sort_20_filled.svg"
    ],
    "plus": [
      "ic_fluent_add_20_regular.svg",
      "ic_fluent_add_20_filled.svg"
    ],
    "link": [
      "ic_fluent_branch_fork_20_regular.svg",
      "ic_fluent_branch_fork_20_filled.svg"
    ]
  };
  const scriptSource = document.currentScript?.src;
  const assetRoot = scriptSource ? scriptSource.replace(/\/shared\/ui-icons\.js(?:[?#].*)?$/u, '/assets/ui-icons/') : '../assets/ui-icons/';
  const uri = filename => 'url("' + assetRoot + filename + '")';
  const masks = new Map(Object.entries(icons).map(([name, files]) => [name, files.map(uri)]));
  const automatic = '.record-actions-toggle,.batch-result-menu,.primary-group-navigation button';
  function enhance(element) {
    if (!(element instanceof Element)) return;
    if (!element.hasAttribute('data-ui-icon')) {
      const name = element.matches('.record-actions-toggle') ? 'more' : element.matches('.batch-result-menu') ? 'close' : element.matches('.primary-group-navigation button') ? 'folder' : '';
      if (!name) { for (const child of [...element.children]) if (child.classList.contains('ui-action-icon')) child.remove(); element.classList.remove('ui-icon-ready'); return; }
      element.setAttribute('data-ui-icon', name);
      if (name === 'more' || name === 'close') for (const child of [...element.childNodes]) if (child.nodeType === Node.TEXT_NODE) child.remove();
    }
    const name = element.getAttribute('data-ui-icon');
    const values = masks.get(name); if (!values) return;
    let icon = [...element.children].find(child => child.classList.contains('ui-action-icon'));
    if (!icon) {
      icon = document.createElement('span'); icon.className = 'ui-action-icon'; icon.setAttribute('aria-hidden', 'true');
      for (const className of ['ui-icon-outline', 'ui-icon-solid']) { const layer = document.createElement('span'); layer.className = className; icon.append(layer); }
      element.prepend(icon);
    }
    if (icon.dataset.icon !== name) {
      icon.dataset.icon = name;
      icon.style.setProperty('--ui-icon-outline', values[0]); icon.style.setProperty('--ui-icon-solid', values[1]);
    }
    element.classList.add('ui-icon-ready');
  }
  function refresh(root = document) {
    if (root instanceof Element) enhance(root);
    root.querySelectorAll?.('[data-ui-icon],' + automatic).forEach(enhance);
  }
  refresh();
  new MutationObserver(records => {
    const roots = new Set();
    for (const record of records) {
      if (record.target instanceof Element) roots.add(record.target);
      for (const node of record.addedNodes) if (node instanceof Element) roots.add(node);
    }
    for (const root of roots) if (root.isConnected) refresh(root);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ui-icon'] });
  window.InMomentIcons = { refresh };
})();
