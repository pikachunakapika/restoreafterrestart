/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */

const { Gio, GLib, GObject, Meta} = imports.gi;
const Mainloop = imports.mainloop;
const runDialog = imports.ui.runDialog;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

// Get the GSchema source so we can lookup our settings
var gschema = Gio.SettingsSchemaSource.new_from_directory(
    Me.dir.get_child('schemas').get_path(),
    Gio.SettingsSchemaSource.get_default(),
    false
);

var settings = new Gio.Settings({
    settings_schema: gschema.lookup('org.gnome.shell.extensions.restoreafterrestart', true)
});

var oldCalls = {};

function registerOverride(name, func) {
    oldCalls[name] = runDialog.RunDialog.prototype[name];
    runDialog.RunDialog.prototype[name] = func;
}

function removeOverride(name) {
    runDialog.RunDialog.prototype[name] = oldCalls[name];
}

function guessWindowXID(win) {
    // We cache the result so we don't need to redetect.
    if (win._noTitleBarWindowID) {
        return win._noTitleBarWindowID;
    }

    /**
     * If window title has non-utf8 characters, get_description() complains
     * "Failed to convert UTF-8 string to JS string: Invalid byte sequence in conversion input",
     * event though get_title() works.
     */
    try {
        let m = win.get_description().match(/0x[0-9a-f]+/);
        if (m && m[0]) {
            return win._noTitleBarWindowID = m[0];
        }
    } catch (err) { }

    // use xwininfo, take first child.
    let act = win.get_compositor_private();
    let xwindow = act && act['x-window'];
    if (xwindow) {
        let xwininfo = GLib.spawn_command_line_sync('xwininfo -children -id 0x%x'.format(xwindow));
        if (xwininfo[0]) {
            let str = xwininfo[1].toString();

            /**
             * The X ID of the window is the one preceding the target window's title.
             * This is to handle cases where the window has no frame and so
             * act['x-window'] is actually the X ID we want, not the child.
             */
            let regexp = new RegExp('(0x[0-9a-f]+) +"%s"'.format(win.title));
            let m = str.match(regexp);
            if (m && m[1]) {
                return win._noTitleBarWindowID = m[1];
            }

            // Otherwise, just grab the child and hope for the best
            m = str.split(/child(?:ren)?:/)[1].match(/0x[0-9a-f]+/);
            if (m && m[0]) {
                return win._noTitleBarWindowID = m[0];
            }
        }
    }

    // Try enumerating all available windows and match the title. Note that this
    // may be necessary if the title contains special characters and `x-window`
    // is not available.
    let result = GLib.spawn_command_line_sync('xprop -root _NET_CLIENT_LIST');
    if (result[0]) {
        let str = result[1].toString();

        // Get the list of window IDs.
        if (str.match(/0x[0-9a-f]+/g) == null)
            return null;
        let windowList = str.match(/0x[0-9a-f]+/g);

        // For each window ID, check if the title matches the desired title.
        for (var i = 0; i < windowList.length; ++i) {
            let cmd = 'xprop -id "' + windowList[i] + '" _NET_WM_NAME _NO_TITLE_BAR_ORIGINAL_STATE';
            let result = GLib.spawn_command_line_sync(cmd);

            if (result[0]) {
                let output = result[1].toString();
                let isManaged = output.indexOf("_NO_TITLE_BAR_ORIGINAL_STATE(CARDINAL)") > -1;
                if (isManaged) {
                    continue;
                }

                let title = output.match(/_NET_WM_NAME(\(\w+\))? = "(([^\\"]|\\"|\\\\)*)"/);

                // Is this our guy?
                if (title && title[2] == win.title) {
                    return windowList[i];
                }
            }
        }
    }

    // debugging for when people find bugs..
    return null;
}

function saveWindows() {
    
    let savedStates = [];

    const windows = global.get_window_actors().filter(
        w => w.meta_window.get_window_type() !== Meta.WindowType.DESKTOP);

    windows.forEach((window) => {
        const metaWindow = window.get_meta_window();      
        const xid = guessWindowXID(metaWindow);

        let frameBounds = metaWindow.get_frame_rect();
        savedStates.push({id: xid, x: frameBounds.x, y: frameBounds.y, width: frameBounds.width, height: frameBounds.height});
    });

    this.settings.set_value(
        'saved-state',
        new GLib.Variant('s', JSON.stringify(savedStates))
    );
    
}

function my_restart(params) {
    saveWindows();

    oldCalls['_restart'].call(this, params);
}

function adjustWindow(savedState) {
    const windows = global.get_window_actors().filter(
        w => w.meta_window.get_window_type() !== Meta.WindowType.DESKTOP);

    windows.forEach((window) => {
        const metaWindow = window.get_meta_window();      
        const xid = guessWindowXID(metaWindow);

        if (xid == savedState.id) {

            metaWindow.move_resize_frame(false, savedState.x,savedState.y,savedState.width,savedState.height);
            metaWindow.raise();
            return;
        }
    });
}

function restoreWindows() {
    let json = this.settings.get_value('saved-state').unpack();
    let savedState = JSON.parse(json);

    savedState.forEach((savedState) => {
        adjustWindow(savedState);
    });
}

class Extension {
    constructor() {
        
    }

    enable() {        
        
        Mainloop.timeout_add(1000, () =>  {
            restoreWindows();
            return false;
        });
        
        registerOverride('_restart', my_restart);
    }

    disable() {
        removeOverride('_restart');
    }
}

function init() {
    
    return new Extension();
}
