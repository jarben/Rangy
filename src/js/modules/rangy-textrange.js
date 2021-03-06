/**
 * @license Text Commands module for Rangy.
 * A generic framework for creating text mutation commands for Ranges and Selections
 *
 * Part of Rangy, a cross-browser JavaScript range and selection library
 * http://code.google.com/p/rangy/
 *
 * Depends on Rangy core.
 *
 * Copyright %%build:year%%, Tim Down
 * Licensed under the MIT license.
 * Version: %%build:version%%
 * Build date: %%build:date%%
 */
/**
 * Scope
 *
 * - Add ability to move range boundaries by character or word offsets
 * - Ignore text nodes inside <script> or <style> elements
 * - Do not ignore text nodes that are outside normal document flow
 * - Add a find method to search for text (optionally case sensitive, default insensitive) within the range
 * - Add ability to add custom word boundary finder (regex?)
 * - Add method to range to return a boundary as a text offset within a node
 * - Add method to selection to get the selection as text offsets within an optional node (body otherwise)
 * - Add method to selection to set the selection as text offsets within an optional node (body otherwise) and direction
 * - Add method to selection to return visible text
 * - Add window.find() equivalent
 * - Add innerText equivalent
 *
 * Potential API
 *
 * Range additions
 *
 * -
 *
 *
 * References
 *
 * https://www.w3.org/Bugs/Public/show_bug.cgi?id=13145
 * http://aryeh.name/spec/innertext/innertext.html
 * http://dvcs.w3.org/hg/editing/raw-file/tip/editing.html
 *
 */

rangy.createModule("TextRange", function(api, module) {
    api.requireModules( ["WrappedSelection"] );

    var UNDEF = "undefined";
    var dom = api.dom, util = api.util, DomPosition = dom.DomPosition;

    var log = log4javascript.getLogger("rangy.textrange");

    var getComputedStyleProperty;

    if (typeof window.getComputedStyle != UNDEF) {
        getComputedStyleProperty = function(el, propName) {
            return dom.getWindow(el).getComputedStyle(el, null)[propName];
        };
    } else if (typeof document.documentElement.currentStyle != UNDEF) {
        getComputedStyleProperty = function(el, propName) {
            return el.currentStyle[propName];
        };
    } else {
        module.fail("No means of obtaining computed style properties found");
    }

    var defaultOptions = {
        normalizeWhiteSpace: false
    };

    // "A block node is either an Element whose "display" property does not have
    // resolved value "inline" or "inline-block" or "inline-table" or "none", or a
    // Document, or a DocumentFragment."
    function isBlockNode(node) {
        return node
            && ((node.nodeType == 1 && !/^(inline(-block|-table)?|none)$/.test(getComputedDisplay(node)))
            || node.nodeType == 9 || node.nodeType == 11);
    }

    function isTextNodePre(textNode) {
        var el = textNode.parentNode;
        return !!el &&
            el.nodeType == 1 &&
            !/^(pre|(-moz-)?pre-wrap)$/.test(getComputedStyleProperty(el, "whiteSpace"))
    }

    var inlineDisplayRegex = /^inline(-block|-table)?$/i;

    function isNonInlineElement(node) {
        return node && node.nodeType == 1 && !inlineDisplayRegex.test(getComputedDisplay(node));
    }

    function getLastDescendantOrSelf(node) {
        var lastChild = node.lastChild;
        return lastChild ? getLastDescendantOrSelf(lastChild) : node;
    }

    function containsPositions(node) {
        return dom.isCharacterDataNode(node)
            || !/^(area|base|basefont|br|col|frame|hr|img|input|isindex|link|meta|param)$/i.test(node.nodeName);
    }

    var breakingSpaceRegex = /^[\u0009-\u000d\u0020\u0085\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]$/;

    var spacesRegex = /^[ \t\f\r\n]+$/;
    var spacesMinusLineBreaksRegex = /^[ \t\f\r]+$/;

    function getAncestors(node) {
    	var ancestors = [];
    	while (node.parentNode) {
    		ancestors.unshift(node.parentNode);
    		node = node.parentNode;
    	}
    	return ancestors;
    }

    function getAncestorsAndSelf(node) {
        return getAncestors(node) . concat([node]);
    }

    // Opera 11 puts HTML elements in the null namespace, it seems, and IE 7 has undefined namespaceURI
    function isHtmlNode(node) {
        var ns;
        return typeof (ns = node.namespaceURI) == UNDEF || (ns === null || ns == "http://www.w3.org/1999/xhtml");
    }

    function isHtmlElement(node, tagNames) {
        if (!node || node.nodeType != 1 || !isHtmlNode(node)) {
            return false;
        }
        switch (typeof tagNames) {
            case "string":
                return node.tagName.toLowerCase() == tagNames.toLowerCase();
            case "object":
                return new RegExp("^(" + tagNames.join("|S") + ")$", "i").test(node.tagName);
            default:
                return true;
        }
    }

    function nextNodeDescendants(node) {
        while (node && !node.nextSibling) {
            node = node.parentNode;
        }
        if (!node) {
            return null;
        }
        return node.nextSibling;
    }

    function nextNode(node, excludeChildren) {
        if (!excludeChildren && node.hasChildNodes()) {
            return node.firstChild;
        }
        return nextNodeDescendants(node);
    }

    function previousNode(node) {
        var previous = node.previousSibling;
        if (previous) {
            node = previous;
            while (node.hasChildNodes()) {
                node = node.lastChild;
            }
            return node;
        }
        var parent = node.parentNode;
        if (parent && parent.nodeType == 1) {
            return parent;
        }
        return null;
    }

    function isHidden(node) {
        var ancestors = getAncestorsAndSelf(node);
        for (var i = 0, len = ancestors.length; i < len; ++i) {
            if (ancestors[i].nodeType == 1 && getComputedDisplay(ancestors[i]) == "none") {
                return true;
            }
        }

        return false;
    }

    function isVisibilityHiddenTextNode(textNode) {
        var el;
        return textNode.nodeType == 3
            && (el = textNode.parentNode)
            && getComputedStyleProperty(el, "visibility") == "hidden";
    }

    // "A whitespace node is either a Text node whose data is the empty string; or
    // a Text node whose data consists only of one or more tabs (0x0009), line
    // feeds (0x000A), carriage returns (0x000D), and/or spaces (0x0020), and whose
    // parent is an Element whose resolved value for "white-space" is "normal" or
    // "nowrap"; or a Text node whose data consists only of one or more tabs
    // (0x0009), carriage returns (0x000D), and/or spaces (0x0020), and whose
    // parent is an Element whose resolved value for "white-space" is "pre-line"."
    function isWhitespaceNode(node) {
        if (!node || node.nodeType != 3) {
            return false;
        }
        var text = node.data;
        if (text == "") {
            return true;
        }
        var parent = node.parentNode;
        if (!parent || parent.nodeType != 1) {
            return false;
        }
        var computedWhiteSpace = getComputedStyleProperty(node.parentNode, "whiteSpace");

        return (/^[\t\n\r ]+$/.test(text) && /^(normal|nowrap)$/.test(computedWhiteSpace))
            || (/^[\t\r ]+$/.test(text) && computedWhiteSpace == "pre-line");
    }

    // "node is a collapsed whitespace node if the following algorithm returns
    // true:"
    function isCollapsedWhitespaceNode(node) {
    	// "If node's data is the empty string, return true."
    	if (node.data == "") {
    		return true;
    	}

    	// "If node is not a whitespace node, return false."
    	if (!isWhitespaceNode(node)) {
    		return false;
    	}

    	// "Let ancestor be node's parent."
    	var ancestor = node.parentNode;

    	// "If ancestor is null, return true."
    	if (!ancestor) {
    		return true;
    	}

    	// "If the "display" property of some ancestor of node has resolved value "none", return true."
        if (isHidden(node)) {
            return true;
        }

    	// "While ancestor is not a block node and its parent is not null, set
    	// ancestor to its parent."
    	while (!isBlockNode(ancestor) && ancestor.parentNode) {
    		ancestor = ancestor.parentNode;
    	}

    	// "Let reference be node."
    	var reference = node;

    	// "While reference is a descendant of ancestor:"
    	while (reference != ancestor) {
    		// "Let reference be the node before it in tree order."
    		reference = previousNode(reference);

    		// "If reference is a block node or a br, return true."
    		if (isBlockNode(reference) || isHtmlElement(reference, "br")) {
    			return true;
    		}

    		// "If reference is a Text node that is not a whitespace node, or is an
    		// img, break from this loop."
    		if ((reference.nodeType == 3 && !isWhitespaceNode(reference)) || isHtmlElement(reference, "img")) {
    			break;
    		}
    	}

    	// "Let reference be node."
    	reference = node;

    	// "While reference is a descendant of ancestor:"
    	var stop = nextNodeDescendants(ancestor);
    	while (reference != stop) {
    		// "Let reference be the node after it in tree order, or null if there
    		// is no such node."
    		reference = nextNode(reference);

    		// "If reference is a block node or a br, return true."
    		if (isBlockNode(reference) || isHtmlElement(reference, "br")) {
    			return true;
    		}

    		// "If reference is a Text node that is not a whitespace node, or is an
    		// img, break from this loop."
    		if ((reference && reference.nodeType == 3 && !isWhitespaceNode(reference)) || isHtmlElement(reference, "img")) {
    			break;
    		}
    	}

    	// "Return false."
    	return false;
    }

    function isVisibleTextNode(node) {
        return node
            && node.nodeType == 3
            && !isHidden(node)
            && !isVisibilityHiddenTextNode(node)
            && !isCollapsedWhitespaceNode(node)
            && !/^(script|style)$/i.test(node.parentNode.nodeName);
    }

    function isVisibleElement(el) {

    }

    // Test for old IE's incorrect display properties
    var tableCssDisplayBlock;
    (function() {
        var table = document.createElement("table");
        document.body.appendChild(table);
        tableCssDisplayBlock = (getComputedStyleProperty(table, "display") == "block");
        document.body.removeChild(table);
    })();

    api.features.tableCssDisplayBlock = tableCssDisplayBlock;

    var defaultDisplayValueForTag = {
        table: "table",
        caption: "table-caption",
        colgroup: "table-column-group",
        col: "table-column",
        thead: "table-header-group",
        tbody: "table-row-group",
        tfoot: "table-footer-group",
        tr: "table-row",
        td: "table-cell",
        th: "table-cell"
    };

    // Corrects IE's "block" value for table-related elements
    function getComputedDisplay(el) {
        var display = getComputedStyleProperty(el, "display");
        var tagName = el.tagName.toLowerCase();
        return (display == "block"
                && tableCssDisplayBlock
                && defaultDisplayValueForTag.hasOwnProperty(tagName))
            ? defaultDisplayValueForTag[tagName] : display;
    }

    function isCollapsedNode(node) {
        var type = node.nodeType;
        log.debug("isCollapsedNode", isHidden(node), /^(script|style)$/i.test(node.nodeName), isCollapsedWhitespaceNode(node));
        return type == 7 /* PROCESSING_INSTRUCTION */
            || type == 8 /* COMMENT */
            || isHidden(node)
            || /^(script|style)$/i.test(node.nodeName)
            || isVisibilityHiddenTextNode(node)
            || isCollapsedWhitespaceNode(node);
    }

    function isIgnoredNode(node) {
        var type = node.nodeType;
        return type == 7 /* PROCESSING_INSTRUCTION */
            || type == 8 /* COMMENT */
            || (type == 1 && getComputedDisplay(node) == "none");
    }

    function hasInnerText(node) {
        if (!isCollapsedNode(node)) {
            if (node.nodeType == 3) {
                return true;
            } else {
                for (var child = node.firstChild; child; child = child.nextSibling) {
                    if (hasInnerText(child)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function getLeadingSpace(el) {
        switch (getComputedDisplay(el)) {
            case "inline":
                var child = el.firstChild;
                while (child) {
                    if (!isIgnoredNode(child)) {
                        return child.nodeType == 1 ? getLeadingSpace(child) : ""
                    }
                    child = child.nextSibling;
                }
                return "";
            case "inline-block":
            case "inline-table":
            case "none":
            case "table-cell":
            case "table-column":
            case "table-column-group":
                return "";
            default:
                return "\n";
        }
    }

    function getTrailingSpace(el) {
        switch (getComputedDisplay(el)) {
            case "inline":
                var child = el.lastChild;
                while (child) {
                    if (!isIgnoredNode(child)) {
                        return child.nodeType == 1 ? getTrailingSpace(child) : ""
                    }
                    child = child.previousSibling;
                }
                return "";
            case "inline-block":
            case "inline-table":
            case "none":
            case "table-column":
            case "table-column-group":
                return "";
            case "table-cell":
                return "\t";
            default:
                return hasInnerText(el) ? "\n" : "";
        }
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    function Iterator() {}

    Iterator.prototype = {
        peekNext: function() {
            return (typeof this._next != UNDEF) ? this._next : (this._next = this._getNext(this.current));
        },

        hasNext: function() {
            return !!this.peekNext();
        },

        next: function(item) {
            if (typeof item != UNDEF) {
                this.setCurrent(item);
            }
            this.current = this.peekNext();
            delete this._next;
            return this.current;
        },

        peekPrevious: function() {
            return (typeof this._previous != UNDEF) ? this._previous : (this._previous = this._getPrevious(this.current));
        },

        hasPrevious: function() {
            return !!this.peekPrevious();
        },

        setCurrent: function(item) {
            this.current = item;
            delete this._previous;
            delete this._next;
        },

        previous: function(item) {
            if (typeof item != UNDEF) {
                this.setCurrent(item);
            }
            this.current = this.peekPrevious();
            delete this._previous;
            return this.current;
        }
    };

    function extendIterator(constructor, props) {
        constructor.prototype = new Iterator();
        util.extend(constructor.prototype, props);
    }

    function PositionIterator(node, offset) {
        if (node instanceof DomPosition) {
            offset = node.offset;
            node = node.node;
        }
        this.current = new DomPosition(node, offset);
    }

    extendIterator(PositionIterator, {
        _getNext: function(current) {
            var node = current.node, offset = current.offset;
            if (!node) {
                return null;
            }
            var nextNode, nextOffset, child;
            if (offset == dom.getNodeLength(node)) {
                // Move onto the next node
                nextNode = node.parentNode;
                nextOffset = nextNode ? dom.getNodeIndex(node) + 1 : 0;
            } else {
                if (dom.isCharacterDataNode(node)) {
                    nextNode = node;
                    nextOffset = offset + 1;
                } else {
                    child = node.childNodes[offset];
                    // Go into the children next, if children there are
                    if (containsPositions(child)) {
                        nextNode = child;
                        nextOffset = 0;
                    } else {
                        nextNode = node;
                        nextOffset = offset + 1;
                    }
                }
            }
            return nextNode ? new DomPosition(nextNode, nextOffset) : null;
        },

        _getPrevious: function(current) {
            var node = current.node, offset = current.offset;
            if (!node) {
                return null;
            }
            var previousNode, previousOffset, child;
            if (offset == 0) {
                previousNode = node.parentNode;
                previousOffset = previousNode ? dom.getNodeIndex(node) : 0;
            } else {
                if (dom.isCharacterDataNode(node)) {
                    previousNode = node;
                    previousOffset = offset - 1;
                } else {
                    child = node.childNodes[offset - 1];
                    // Go into the children next, if children there are
                    if (containsPositions(child)) {
                        previousNode = child;
                        previousOffset = dom.getNodeLength(child);
                    } else {
                        previousNode = node;
                        previousOffset = offset - 1;
                    }
                }
            }
            return previousNode ? new DomPosition(previousNode, previousOffset) : null;
        }
    });

    api.PositionIterator = PositionIterator;

    /*----------------------------------------------------------------------------------------------------------------*/

    /*
    Create filtered iterator that skips

    - Whole whitespace nodes that do not affect rendering
    - Hidden (CSS visibility/display) elements
    - Script and style elements
    - <br> elements that do not affect rendering (No. Too difficult. All non-hidden <br>s are counted).
    - collapsed whitespace characters

    We also need to consider implicit text characters between elements (line breaks between blocks, tabs between table
    cells etc.)

    Final iterator will move between text positions, including those between elements. For example, in
    <td>1</td>    <td>2</td>, text position for the tab character at will be <td>1</td>|    <td>2</td>
     */

    // This iterator iterates over positions within visible nodes
    function VisiblePositionIterator(node, offset) {
        if (node instanceof DomPosition) {
            offset = node.offset;
            node = node.node;
        }
        this._iterator = new PositionIterator(node, offset);
        this.current = new DomPosition(node, offset);
    }

    extendIterator(VisiblePositionIterator, {
        _getNext: function(current) {
            var iterator = this._iterator;
            iterator.setCurrent(current);
            var node = iterator.next().node;
            log.debug("node: " + dom.inspectNode(node) + ", isCollapsedNode(node): " + isCollapsedNode(node), iterator.current.inspect())
            if (isCollapsedNode(node)) {
                // We're skipping this node and all its descendants
                var newPos = new DomPosition(node.parentNode, dom.getNodeIndex(node) + 1);
                iterator.setCurrent(newPos);
                log.info("New pos: " + newPos.inspect() + ", old: " + current.inspect())
            }
            return iterator.current;
        },

        _getPrevious: function(current) {
            var iterator = this._iterator;
            iterator.setCurrent(current);
            var node = iterator.previous().node;
            if (isCollapsedNode(node)) {
                // We're skipping this node and all its descendants
                var newPos = new DomPosition(node.parentNode, dom.getNodeIndex(node));
                iterator.setCurrent(newPos);
            }
            return iterator.current;
        }
    });

    api.VisiblePositionIterator = VisiblePositionIterator;

    /*----------------------------------------------------------------------------------------------------------------*/

    /*

    Now, the final iterator which iterates over text positions. Each text position is separated by exactly one
    character.

    To get to this, this iterator iterates over visible positions using an underlying VisiblePositionIterator and
    performs the following steps:

    - Ellision of spaces, including between nodes
    - Inclusion of spaces between nodes

    Rules:
    - In <b>1 </b><i> 2</i>, the visible space is inside the earlier (<b>) element.
    - In <div>1 </div>, the final space is ignored.

     */

    function TextPositionIterator(start, end, position) {
        log.info("TextPositionIterator", start.inspect(), end.inspect())
        this._iterator = new VisiblePositionIterator();
        start = start ? this.adjustPosition(start) : null;
        end = end ? this.adjustPosition(end) : null;
        position = position ? this.adjustPosition(position) : start;
        this.current = position;
        this.start = start;
        this.end = end;
    }

    extendIterator(TextPositionIterator, {
        _getTextNodeProperties: function(textNode) {
            if (!this.textNodeProperties || this.textNodeProperties.node != textNode) {
                var spaceRegex = null, elideSpaces = false;
                var cssWhitespace = getComputedStyleProperty(textNode.parentNode, "whiteSpace");
                if (cssWhitespace == "pre-line") {
                    spaceRegex = spacesMinusLineBreaksRegex;
                    elideSpaces = true;
                } else if (cssWhitespace == "normal" || cssWhitespace == "nowrap") {
                    spaceRegex = spacesRegex;
                    elideSpaces = true;
                }

                this.textNodeProperties = {
                    node: textNode,
                    text: textNode.data,
                    spaceRegex: spaceRegex,
                    elideSpaces: elideSpaces
                };
            }
            return this.textNodeProperties;
        },

        getCharacterBetween: function(position, nextPosition) {
            log.info("getCharacterAfter on " + position.inspect());

            if (!nextPosition || !position) {
                var iterator = this._iterator;
                iterator.setCurrent(position);
                if (!nextPosition) {
                    nextPosition = iterator.next();
                } else {
                    iterator.setCurrent(nextPosition);
                    position = iterator.previous();
                }
            }

            var currentNode = position.node,
                nextNode = nextPosition.node,
                nextOffset = nextPosition.offset;

            var props, character, isCharacterCollapsible = false, isTrailingSpace = false, leadingSpace;
            var previousPosition, previousChar;

            if (nextNode.nodeType == 3) {
                // Advance to the next position within the text node, eliding spaces as necessary
                props = this._getTextNodeProperties(nextNode);
                if (props.elideSpaces) {
                    if (nextOffset > 0 && props.spaceRegex.test(props.text.charAt(nextOffset - 1))) {
                        isCharacterCollapsible = true;
                        if (nextOffset > 1 && props.spaceRegex.test(props.text.slice(nextOffset - 2, nextOffset - 1))) {
                            // Character is a collapsible space preceded by another collapsible space, so should be skipped
                            return ["", false];
                        }
                    }
                }

                // Handle space
                if (isCharacterCollapsible) {
                    // Check if we're at the end and therefore may need to skip this
                    if (nextOffset == props.text.length) {
                        // Need to look ahead later to check whether this character is rendered or not
                        isTrailingSpace = true;
                        character = "";
                    } else {
                        return [" ", true];
                    }
                } else {
                    // No space elision in this case
                    return [props.text.charAt(nextOffset - 1), false];
                }
            } else if (nextNode == currentNode) {
                // The offset is a child node offset. Check the node we've just passed.
                var nodePassed = nextNode.childNodes[nextOffset - 1];
                if (nodePassed) {
                    if (nodePassed.nodeType == 1) {
                        // Special case for <br> elements
                        return (nodePassed.tagName.toLowerCase() == "br") ? "\n" : getTrailingSpace(nodePassed);
                    }
                } else {
                    throw new Error("No child node at index " + (nextOffset - 1) + " in " + dom.inspectNode(nextNode));
                }
            } else if (nextNode.nodeType == 1
                    && nextOffset == 0
                    && ( !(previousPosition = iterator.previous(position))
                        || !(previousChar = this.getCharacterBetween(previousPosition, position))
                        || previousChar[0] !== "\n")
                    && (leadingSpace = getLeadingSpace(nextNode)) !== "") {
                return [leadingSpace, false];
            }

            // Now we as yet have no character. Check if we need to skip forward to pass a character, or to check if the
            // next character is rendered
            if (nextNode) {
                // No character has definitely been traversed over, so skip forward recursively until we do
                var tempNext = this.getCharacterBetween(nextPosition, null);
                if (isTrailingSpace && tempNext && tempNext.previousCharCollapsible) {
                    // The next character is collapsible space, so the trailing space is rendered
                    return [" ", true];
                } else {
                    return tempNext;
                }
            }

            return null;
        },

        _getNext: function(current) {
            log.info("_getNext on " + current.inspect());
            if (this.end && current.equals(this.end)) {
                return null;
            }

            var iterator = this._iterator;
            iterator.setCurrent(current);

            var nextPosition = iterator.next(),
                currentNode = current.node,
                nextNode = nextPosition.node,
                nextOffset = nextPosition.offset;

            var props, character, isCharacterCollapsible = false, isTrailingSpace = false, leadingSpace, previous;

            if (nextNode.nodeType == 3) {
                // Advance to the next position within the text node, eliding spaces as necessary
                props = this._getTextNodeProperties(nextNode);
                if (props.elideSpaces) {
                    --nextOffset;
                    while ( props.spaceRegex.test(props.text.charAt(nextOffset)) ) {
                        isCharacterCollapsible = true;
                        ++nextOffset;
                    }
                }

                // Handle space
                if (isCharacterCollapsible) {
                    // Check if we're at the end and therefore may need to skip this
                    if (nextOffset == props.text.length) {
                        // Need to look ahead later to check whether this character is rendered or not
                        isTrailingSpace = true;
                        character = "";
                    } else {
                        character = " ";
                    }
                } else {
                    // No space elision in this case
                    character = props.text.charAt(nextOffset - 1);
                    isCharacterCollapsible = false;
                }
            } else if (nextNode == currentNode) {
                // The offset is a child node offset. Check the node we've just passed.
                var nodePassed = nextNode.childNodes[nextOffset - 1];
                if (nodePassed) {
                    if (nodePassed.nodeType == 1) {
                        // Special case for <br> elements
                        if (nodePassed.tagName.toLowerCase() == "br") {
                            character = "\n";
                            isCharacterCollapsible = false;
                        } else {
                            character = getTrailingSpace(nodePassed);
                        }
                    }
                } else {
                    throw new Error("No child node at index " + (nextOffset - 1) + " in " + dom.inspectNode(nextNode));
                }
            } else if (nextNode.nodeType == 1
                    && nextOffset == 0
                    && ( !(previous = this._getPrevious(current)) || previous.previousChar !== "\n")
/*
                    && current.previousChar !== "\n"
*/
                    && (leadingSpace = getLeadingSpace(nextNode)) !== "") {
                character = leadingSpace;
            }

            var next = new DomPosition(nextNode, nextOffset);
            next.previousChar = character;
            next.previousCharCollapsible = isCharacterCollapsible;

            // Check if we need to skip forward to pass a character, or to check if the next character is rendered
            if (character === "" && nextNode) {
                // No character has definitely been traversed over, so skip forward recursively until we do
                var tempNext = this._getNext(next);
                if (isTrailingSpace && tempNext && tempNext.previousCharCollapsible) {
                    // The next character is collapsible space, so the trailing space is rendered
                    next.character = " ";
                } else {
                    next = tempNext;
                }
            }

            return next;
        },

        _getPrevious: function(current) {
            log.info("_getPrevious on " + current.inspect());
            if (this.start && current.equals(this.start)) {
                return null;
            }
            var iterator = this._iterator;
            iterator.setCurrent(current);
            var previous = current, nextAfterPrevious, nextPrevious;

            // Search back until we hit a position that does not go next to the current position, then return the final
            // position reached before that position
            var limit = 0;
            while (previous && limit++ < 10) {
                log.info("previous: " + previous.inspect());
                nextPrevious = iterator.previous();
                if (!nextPrevious) {
                    return null;
                }
                nextAfterPrevious = this._getNext(nextPrevious);
                if (nextAfterPrevious.equals(current)) {
                    previous = nextPrevious;
                } else {
                    previous.previousChar = nextAfterPrevious.previousChar;
                    previous.previousCharCollapsible = nextAfterPrevious.previousCharCollapsible;
                    return previous;
                }
            }
        },

        adjustPosition: function(position) {
            log.info("adjustPosition on " + position.inspect());
            var previous = this._getPrevious(position);
            return previous ? this._getNext(previous) : position;
        }
    });

    api.TextPositionIterator = TextPositionIterator;


    /*----------------------------------------------------------------------------------------------------------------*/

    util.extend(dom, {
        nextNode: nextNode,
        previousNode: previousNode,
        hasInnerText: hasInnerText
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    util.extend(api.selectionPrototype, {
        modify: function() {

        },

        expand: function() {

        },

        moveAnchor: function() {

        },

        moveFocus: function() {

        },

        moveStart: function() {

        },

        moveEnd: function() {

        }
    });

    util.extend(api.rangePrototype, {
        text: function() {
            log.info("text called on range " + this.inspect());
            var iterator = new TextPositionIterator(new DomPosition(this.startContainer, this.startOffset),
                new DomPosition(this.endContainer, this.endOffset));
            var chars = [], pos, limit = 0;
            while ( (pos = iterator.next()) && limit++ < 20 ) {
                chars.push(pos.previousChar);
            }
            return chars.join("");
        },

        htmlText: function() {

        },

        expand: function() {

        },

        moveStart: function() {

        },

        moveEnd: function() {

        },

        findText: function() {

        },

        move: function() {

        },

        pasteHTML: function() {

        },

        select: function() {

        }
    });

    api.find = function() {

    };

    api.innerText = function(el) {
        var range = api.createRange(el);
        range.selectNodeContents(el);
        var text = range.text();
        range.detach();
        return text;
    };

    api.textRange = {
        isBlockNode: isBlockNode,
/*
        isCollapsedBr: isCollapsedBr,
*/
        isCollapsedWhitespaceNode: isCollapsedWhitespaceNode,
        PositionIterator: PositionIterator,
        VisiblePositionIterator: VisiblePositionIterator

    };

});
